/**
 * 王者万象棋推送的数据层（订阅存取 / 拉取 / 宽容解析 / 文案 / 退避）。
 *
 * ## ⚠️⚠️ 整个文件建立在「推断」上，这是有意的
 *
 * 万象棋（2026-09-10 公测）的营地接口**没有任何公开资料**：营地 App 的万象棋专区
 * 可以查棋手资料、战绩、在线状态，但对外只暴露了王者侧的端点。所以本文件里
 * 「营地返回体长什么样」全部按王者侧接口的形状**推断**，实测抓包后需要校准的地方
 * 集中在三处，改这三处就行：
 *   1. 端点路径 —— config 的 `chessProfileApi` / `chessBattleApi`（见 api.js 的
 *      CHESS_DEFAULT_*_ENDPOINT），**不用改代码**；
 *   2. 字段名 —— 本文件的 CHESS_FIELDS / CHESS_ROLE_FIELDS 候选表，把真实字段名
 *      挪到候选数组第一位即可（候选是按「同义度」排的，真实名放最前其余留着兼容）；
 *   3. 返回体形状 —— 解析不出来时打 `logShape` 的 debug 日志（带返回体顶层字段名），
 *      抓包开 debug 就能对着改。
 *
 * 推断不成时**全部安全降级**：解析不出字段 → list 为空 / gameOnline 为 0，
 * 表现是「不推送」，绝不会有半真半假的数据发到群里。
 *
 * ## 与王者推送（pushStore / GameRecordPush.yaml）的关系
 *
 * **刻意完全隔离**：订阅存独立的 ChessPush.yaml，轮询独立一条 cron、独立请求预算。
 * 理由：端点是推断的，未实测前这一整块功能要能一键拔掉（cron 留空即全停），
 * 并且它的任何失败（404、解析不出来、频控）都不能挤占王者推送的请求预算
 * （MAX_REQUESTS_PER_ROUND 才 6 个）或拖累它的轮询节奏。两边只共享纯计算函数：
 * pickNewBattles / diffOnlineState / resolveNextCheck 等从 pushStore 直接 import。
 *
 * 万象棋推送只有两路：战绩推送（chessBattle）/ 上下线提醒（chessOnline）。
 * **开局提醒刻意没做**：王者的开局提醒一半价值在「要不要开一路观战」，而观战服务
 * 只支持王者对局，自走棋开局没有后续动作，单独播一条「开打了」意义不大。
 */
import path from 'node:path'
import fs from 'node:fs'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { quarantineCorrupt } from './safeStore.js'
import { hotBox } from './hotState.js'
import { normalizeName } from './rankStore.js'
export { normalizeName }
// ⚠️ 必须 import 一次再 export（只写 export { x } from './y.js' 是转出，
// 本文件作用域里没有这个绑定），理由见 pushStore.js 同一处注释
import { detectLeftGroups } from './groupIndex.js'
import {
  subGroups,
  withSubGroup,
  withoutSubGroup,
  pickNewBattles,
  diffOnlineState,
  resolveOnlineSince,
  formatOnlineDuration,
  needBattleList,
  isSubActive,
  resolveNextCheck,
  hasOnlineSignal,
  sleep,
  REQUEST_INTERVAL,
  DEFAULT_IDLE_BACKOFF_MAX,
  FETCH_HIDDEN
} from './pushStore.js'
export { subGroups, withSubGroup, withoutSubGroup, sleep, REQUEST_INTERVAL, DEFAULT_IDLE_BACKOFF_MAX, FETCH_HIDDEN }
import ApiService from './api.js'
import { PluginData } from '#components'

const PUSH_FILE = path.join(PluginData, 'ChessPush.yaml')

/** 深拷贝。订阅项里只有字符串/数字/布尔，JSON 往返语义够（同 pushStore） */
const deepCopy = typeof structuredClone === 'function'
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value))

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/* -------------------------------------------------- 推断字段候选表（校准入口 2） */

/**
 * 「营地返回体里同一个意思可能的字段名」，按可信度从高到低排。
 * 实测校准：把抓包看到的真实字段名挪到数组第一位，其余候选留着当向后兼容。
 *
 * ⚠️ 候选名都取自营地现有接口的命名习惯（王者战绩列表 / profile 的字段名放最前）：
 *    万象棋专区与王者共用同一套账号与好友体系，后端同构的概率最大。
 */
const CHESS_FIELDS = {
  /** 单场战绩（列表项） */
  battle: {
    // 场次唯一键（游标用，必须稳定）
    seq: ['gameSeq', 'seq', 'battleId', 'matchId', 'recordId'],
    // 对局结束时间（秒级时间戳，第二个游标）
    time: ['dtEventTime', 'eventTime', 'endTime', 'createTime'],
    // 名次：自走棋的「胜负」就是名次，1 = 吃鸡
    rank: ['rank', 'finalRank', 'placement', 'ranking', 'grade', 'order'],
    // 名次缺失时的展示兜底（1=胜 2=负，沿用王者枚举）
    result: ['gameresult', 'result', 'win'],
    // 用时（秒）
    duration: ['usedTime', 'duration', 'gameTime'],
    // 棋手分（对局后的分）
    score: ['score', 'newScore', 'chessScore', 'newMasterMatchScore'],
    // 棋手分（对局前的分）
    oldScore: ['oldScore', 'chessOldScore', 'oldMasterMatchScore'],
    // 模式名（万象棋的模式，如「经典局」）
    mode: ['mapName', 'modeName', 'gameModeName', 'typeName'],
    // 头像/棋子图标（可选，出不来就不带图）
    icon: ['heroIcon', 'avatar', 'icon', 'playerIcon']
  },
  /** 正在打的局（判活跃用，isSubActive 读 data.isGaming） */
  gaming: {
    isGaming: ['isGaming', 'inGame', 'is_gaming'],
    time: ['dtEventTime', 'eventTime', 'startTime'],
    mode: ['mapName', 'modeName']
  }
}

/** 棋手资料里的在线状态字段（profile 响应，形状按王者 profile 推断） */
const CHESS_ROLE_FIELDS = {
  // 三态沿用王者的实测语义（0=离线 1=在线 2=游戏中），1↔2 抖动不提醒的口径一致
  online: ['gameOnline', 'chessOnline', 'wjqOnline'],
  onlineTime: ['onlineTime', 'online_time'],
  offlineTime: ['offlineTime', 'offline_time'],
  roleName: ['roleName', 'role_name', 'nickName', 'nickname']
}

/** 从对象里按候选名顺序取第一个非空值。0 是合法值（gameOnline=0 真实存在），不算空 */
function pickField (obj, names) {
  for (const name of names) {
    const value = obj?.[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/**
 * 解析不出字段时的形状日志（校准入口 3）。
 * 只打 debug：抓包校准时把 debug 打开，对着这里的字段名改 CHESS_FIELDS。
 */
function logShape (data, source) {
  const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data
  logger.debug(`[万象棋推送] ${source} 返回体顶层字段：${keys}（推断字段没对上时对着这里校准 CHESS_FIELDS）`)
}

/* ------------------------------------------------------------------ 订阅开关 */

/** 一条万象棋订阅上所有的推送开关。disableChessFlag 靠它判「全关了才删记录」 */
export const CHESS_FLAGS = ['chessBattle', 'chessOnline']

/** 某个棋开关是否开着。新功能没有历史包袱，缺字段 = 没开（与王者的 battle 不同） */
export function isChessFlagOn (sub, key) {
  return Boolean(sub?.[key] === true)
}

/** 这条订阅还有任何一路棋推送开着吗 */
export function hasAnyChessFlag (sub) {
  return CHESS_FLAGS.some(key => isChessFlagOn(sub, key))
}

/**
 * 关掉一路棋推送。两路全关才把整条订阅删掉，别留空壳占轮询名额。
 * @returns {{wasOn: boolean, removed: boolean}}
 */
export function disableChessFlag (qq, key) {
  const id = String(qq)
  const list = loadChessList()
  const sub = list[id]
  if (!sub || !isChessFlagOn(sub, key)) return { wasOn: false, removed: false }

  sub[key] = false
  const removed = !hasAnyChessFlag(sub)
  if (removed) delete list[id]
  else list[id] = sub

  saveChessList(list)
  return { wasOn: true, removed }
}

/* ------------------------------------------------------------------ 订阅存取 */

/**
 * 订阅表的解析结果缓存（文件指纹失效，同 pushStore 的做法）。
 * 这张表比王者的那张小得多（万象棋订阅少），缓存主要是省掉轮询里反复 parse。
 */
let listCache = null

function fingerprint () {
  try {
    const stat = fs.statSync(PUSH_FILE, { bigint: true })
    return { mtimeNs: stat.mtimeNs, size: stat.size }
  } catch {
    return null
  }
}

/** 拿缓存里的整张表（不拷贝）。调用方不得修改返回值 */
function currentList () {
  const fp = fingerprint()
  if (!fp) {
    listCache = null
    return {}
  }
  if (listCache && listCache.mtimeNs === fp.mtimeNs && listCache.size === fp.size) return listCache.data

  try {
    const data = readYamlFile(PUSH_FILE)
    const list = data?.pushList
    const value = list && typeof list === 'object' ? list : {}
    listCache = { mtimeNs: fp.mtimeNs, size: fp.size, data: value }
    return value
  } catch (error) {
    // 解析失败隔离坏文件（留证 + 日志），理由见 utils/safeStore.js。
    // 「坏了返回空表」的副作用（空表被写回固化）由隔离兜住
    quarantineCorrupt(PUSH_FILE, error, '[万象棋推送]')
    listCache = null
    return {}
  }
}

/**
 * 读取订阅表（返回拷贝）。文件缺失或损坏返回空表，不抛错。
 * @returns {Record<string, object>} qq -> 订阅项
 */
export function loadChessList () {
  return deepCopy(currentList())
}

/** 整表写回。只在指令场景用（开启/关闭订阅），轮询里一律走 mergeChessState 系列 */
export function saveChessList (pushList) {
  const data = { pushList: pushList || {} }
  writeYamlFile(PUSH_FILE, data)

  // 先写盘成功再对齐缓存，写盘抛错时保持旧值（理由见 pushStore.savePushList）
  const fp = fingerprint()
  listCache = fp ? { mtimeNs: fp.mtimeNs, size: fp.size, data: deepCopy(data.pushList) } : null
}

/**
 * 批内待落盘的 patch。null = 不在批里。
 *
 * ⚠️ 跨热重载共享（hotBox）：checkChessOne 的结构是 begin → await → finally end，
 * 热重载若落在 await 中间，旧实例的 finally 会拿到新实例的变量 —— 退避计数、
 * 游标、基准全丢。教训与修法见 pushStore.js 同一处（2026-10-06 那笔）。
 */
const S = hotBox('chessPushStore.pendingPatches', { pendingPatches: null })

/**
 * 开始一个「订阅写批」。返回 false 表示已经在批里（不支持嵌套）。
 * 批内 mergeChessState 恒返回 true（乐观），不要靠返回值判断订阅是否存在。
 */
export function beginChessBatch () {
  if (S.pendingPatches) return false
  S.pendingPatches = []
  return true
}

/**
 * 结束批并把攒下的 patch 一次落盘。
 * @returns {number} 实际写入的条数
 */
export function endChessBatch () {
  const patches = S.pendingPatches
  S.pendingPatches = null
  if (!patches?.length) return 0
  return mergeChessStates(patches)
}

/**
 * 字段级合并写回单个订阅。写之前重读整表再合并，用户的并发改动不会被覆盖
 * （轮询一轮几十秒，期间用户完全可能开关订阅）。
 * @returns {boolean} 是否写入成功（批内恒 true）
 */
export function mergeChessState (qq, patch) {
  const key = String(qq)
  if (S.pendingPatches) {
    S.pendingPatches.push([key, patch])
    return true
  }

  const list = deepCopy(currentList())
  if (!list[key]) return false

  list[key] = { ...list[key], ...patch }
  saveChessList(list)
  return true
}

/**
 * 批量字段合并写回。语义与逐条 mergeChessState 一致，N 次读写并成 1 次
 * （轮询里给每个退避中的订阅减 skipTicks 时用）。
 * @param {Array<[string|number, object]>} patches
 * @returns {number} 实际写入的条数
 */
export function mergeChessStates (patches) {
  if (!patches?.length) return 0

  const list = deepCopy(currentList())
  let count = 0
  for (const [qq, patch] of patches) {
    const key = String(qq)
    // 订阅已被删除时不重建
    if (!list[key]) continue
    list[key] = { ...list[key], ...patch }
    count += 1
  }

  if (count) saveChessList(list)
  return count
}

/* ------------------------------------------------------- 退群清理（一次落盘） */

/**
 * 把「人已经退了的群」从棋订阅上摘掉，**整表只读改写一次**。
 *
 * 与王者的 sweepLeftGroups 同一套判据（detectLeftGroups 读实时 gml），但落盘
 * 走本文件的 saveChessList —— pushStore.dropLeftGroups 硬编码了王者表，不能复用。
 *
 * ⚠️ 拿不到成员缓存（detectLeftGroups 返回 ok:false）时一个人都不动，
 *    把「查不到」当成「退群了」会一次把所有人的推送全停掉。
 *
 * @param {Record<string, object>} [list] 已读好的订阅表（就地改）。不传自己读
 * @returns {{cleared: number, stopped: number, ok: boolean}}
 */
export function sweepChessLeftGroups (list = null) {
  const table = list || loadChessList()
  const left = detectLeftGroups(
    Object.entries(table).map(([qq, sub]) => ({ qq, groups: subGroups(sub) }))
  )
  if (!left.ok) return { cleared: 0, stopped: 0, ok: false }

  let cleared = 0
  let stopped = 0
  for (const qq of Object.keys(left.gone)) {
    const sub = table[qq]
    if (!sub) continue

    const leftGroups = new Set(left.gone[qq].map(String))
    const all = subGroups(sub)
    const rest = all.filter(gid => !leftGroups.has(gid))
    // 退的群压根不在这条订阅的列表里 —— 无事可做（也保证了幂等）
    if (rest.length === all.length) continue

    const dropped = all.length - rest.length
    if (rest.length) {
      table[qq] = { ...sub, groups: rest, group: rest[0] || '' }
      cleared += dropped
      logger.mark(`[万象棋推送] ${qq} 已退 ${dropped} 个推送群，已摘掉`)
      continue
    }

    delete table[qq]
    stopped += 1
    cleared += dropped
    logger.mark(`[万象棋推送] ${qq} 已退全部推送群，订阅已停`)
  }

  if (cleared || stopped) saveChessList(table)
  return { cleared, stopped, ok: true }
}

/* ------------------------------------------------------------------ 拉取与解析 */

/**
 * 「营地侧取不到数据」的两个码。王者侧实测 profile 回 -10107、战绩端点回 -30032，
 * 是同一件事的两个码；万象棋走同一套账号体系，这两个码大概率语义相同，照认。
 */
const CODE_PROFILE_HIDDEN = -10107
const CODE_USER_NOT_EXIST = -30032

/**
 * 拉取棋手资料（在线状态）。形状照 pushStore.fetchOnlineState：
 * 成功返回归一化状态，营地侧取不到返回 FETCH_HIDDEN，其它失败返回 null。
 *
 * @param {string} campId 营地ID
 * @param {string} qq 属主QQ（authStore 按属主取鉴权候选，必传）
 * @returns {Promise<{gameOnline:number, onlineTime:number, offlineTime:number, roleName:string}|null|symbol>}
 */
export async function fetchChessOnlineState (campId, qq) {
  try {
    const res = await ApiService.getChessProfile(String(campId), String(qq))
    const code = Number(res?.returnCode || 0)

    if (code === CODE_PROFILE_HIDDEN || code === CODE_USER_NOT_EXIST) return FETCH_HIDDEN
    if (code !== 0) {
      logger.debug(`[万象棋推送] ${campId} 主页返回异常码 ${code}: ${res?.returnMsg || ''}`)
      return null
    }

    return normalizeChessOnlineState(res)
  } catch (error) {
    logger.debug(`[万象棋推送] 拉取 ${campId} 在线状态失败: ${error.message}`)
    return null
  }
}

/**
 * 归一化主页响应为在线状态。
 *
 * 形状按王者 profile 推断：`data.roleList[]` 里按 targetRoleId 找主角色。
 * 万象棋专区查的是「棋手」，返回体可能直接平铺在 data 上（没有 roleList），
 * 那就退回把 data 本身当 role 解析 —— 两候选都试，谁有值用谁。
 *
 * @param {object} res 营地接口响应
 * @returns {{gameOnline:number, onlineTime:number, offlineTime:number, roleName:string}}
 */
export function normalizeChessOnlineState (res) {
  const data = res?.data || {}
  const roles = Array.isArray(data.roleList)
    ? data.roleList
    : (Array.isArray(data.roles) ? data.roles : null)

  const role = roles
    ? (roles.find(r => String(r?.roleId || '') === String(data.targetRoleId || '')) || roles[0])
    : data

  if (!role || typeof role !== 'object') {
    logShape(res?.data, '主页（没有 roleList/roles，data 本身也不像角色）')
    return { gameOnline: 0, onlineTime: 0, offlineTime: 0, roleName: '' }
  }

  const state = {
    gameOnline: toInt(pickField(role, CHESS_ROLE_FIELDS.online)),
    onlineTime: toInt(pickField(role, CHESS_ROLE_FIELDS.onlineTime)),
    offlineTime: toInt(pickField(role, CHESS_ROLE_FIELDS.offlineTime)),
    roleName: String(pickField(role, CHESS_ROLE_FIELDS.roleName) || '')
  }

  // 推断字段全没对上（三字段全 0 且没有名字）时记一条形状日志帮校准
  if (!state.gameOnline && !state.onlineTime && !state.offlineTime && !state.roleName) {
    logShape(role, '主页（在线字段全没对上）')
  }

  return state
}

/**
 * 拉取战绩列表。形状照 pushStore.fetchLatest：
 * 成功返回归一化数据，营地侧取不到返回 FETCH_HIDDEN，其它失败返回 null。
 *
 * @param {string} campId 营地ID
 * @param {string} qq 属主QQ
 * @returns {Promise<{list:Array, gaming:object|null, isGaming:boolean}|null|symbol>}
 */
export async function fetchChessLatest (campId, qq) {
  try {
    const res = await ApiService.getChessBattleList(String(campId), String(qq), { lastTime: 0 })
    const code = Number(res?.returnCode || 0)

    if (code === CODE_PROFILE_HIDDEN || code === CODE_USER_NOT_EXIST) return FETCH_HIDDEN
    if (code !== 0) {
      logger.debug(`[万象棋推送] ${campId} 战绩返回异常码 ${code}: ${res?.returnMsg || ''}`)
      return null
    }

    // 隐藏战绩：王者侧 returnCode=0 + invisible 标记，棋大概率同构
    if (res?.data?.invisible) return FETCH_HIDDEN

    return normalizeChessBattles(res)
  } catch (error) {
    logger.debug(`[万象棋推送] 拉取 ${campId} 战绩失败: ${error.message}`)
    return null
  }
}

/**
 * 归一化战绩列表响应。
 *
 * 输出形状对齐王者侧（list[] 带 gameSeq/dtEventTime，gaming 带 isGaming），
 * 这样 pickNewBattles / isSubActive / needBattleList 这些纯函数可以原样复用。
 * 棋特有的字段（名次/棋手分）加在归一化项上，文案层用。
 *
 * @param {object} res 营地接口响应
 * @returns {{list:Array<object>, gaming:object|null, isGaming:boolean}}
 */
export function normalizeChessBattles (res) {
  const data = res?.data || {}
  const rawList = Array.isArray(data.list)
    ? data.list
    : (Array.isArray(data.battleList) ? data.battleList : [])

  // 只在「连列表字段都找不到」时记形状日志：空数组是新棋手的合法状态，不是解析失败
  if (!rawList.length && !Array.isArray(data.list) && !Array.isArray(data.battleList) &&
    data && typeof data === 'object') {
    logShape(data, '战绩（list/battleList 都不是数组）')
  }

  const F = CHESS_FIELDS.battle
  const list = rawList.filter(item => item && typeof item === 'object').map(item => ({
    // 王者同名字段：让 pickNewBattles / isSubActive 直接吃
    gameSeq: String(pickField(item, F.seq) ?? ''),
    dtEventTime: toInt(pickField(item, F.time)),
    // 棋特有
    rank: toInt(pickField(item, F.rank)) || 0,
    result: toInt(pickField(item, F.result)) || 0,
    durationSec: toInt(pickField(item, F.duration)),
    modeName: String(pickField(item, F.mode) || ''),
    score: toInt(pickField(item, F.score)),
    oldScore: toInt(pickField(item, F.oldScore)),
    icon: String(pickField(item, F.icon) || '')
  }))

  const rawGaming = data.gaming && typeof data.gaming === 'object' ? data.gaming : null
  const G = CHESS_FIELDS.gaming
  const gaming = rawGaming
    ? {
        isGaming: Boolean(pickField(rawGaming, G.isGaming)),
        dtEventTime: toInt(pickField(rawGaming, G.time)),
        modeName: String(pickField(rawGaming, G.mode) || '')
      }
    : null

  return { list, gaming, isGaming: Boolean(gaming?.isGaming) }
}

/* ------------------------------------------------------------------ 纯计算 */

/**
 * 筛出「上次推送之后」的新场次，从旧到新返回。
 *
 * 直接复用王者的 pickNewBattles：归一化后的列表项带同名的 gameSeq/dtEventTime，
 * 游标从棋订阅项的 chessLastGameSeq/chessLastGameTime 通过视图对象接进去
 * （两路推送的字段在各自的表里，同名键互不干扰）。
 *
 * @param {Array<object>} list 归一化后的战绩列表（假定服务端按时间倒序）
 * @param {object} sub 棋订阅项
 * @returns {Array<object>} 新场次，从旧到新
 */
export function pickNewChessBattles (list = [], sub = {}) {
  return pickNewBattles(list, {
    lastGameSeq: sub.chessLastGameSeq,
    lastGameTime: sub.chessLastGameTime
  })
}

/**
 * 统计一段时间内打了什么，下线收工总结用（同一份列表，不额外请求）。
 *
 * 自走棋没有「胜/负」，统计口径是名次：吃鸡次数（第 1 名）和前四次数。
 * 名次解析不出来的场只进 count。
 *
 * @param {Array<object>} list 归一化后的战绩列表（倒序）
 * @param {number|string} sinceTime 起始时间戳（秒），一般是本次上线时刻
 * @returns {{count:number, top1:number, top4:number, scoreFrom:number, scoreTo:number}}
 */
export function summarizeChessSession (list = [], sinceTime = 0) {
  const since = toInt(sinceTime)
  const played = since > 0
    ? (Array.isArray(list) ? list : []).filter(item => toInt(item?.dtEventTime) >= since)
    : []

  const ranked = played.filter(item => item.rank >= 1)

  // 倒序列表：第一项最新、最后一项最早。棋手分取这段区间的首尾
  //（要求前后分都 > 0 且不等：相等可能是「这局不影响分」）
  const withScore = played.filter(item => item.score > 0 && item.oldScore > 0 && item.oldScore !== item.score)
  const earliest = withScore[withScore.length - 1]
  const newest = withScore[0]

  return {
    count: played.length,
    top1: ranked.filter(item => item.rank === 1).length,
    top4: ranked.filter(item => item.rank <= 4).length,
    scoreFrom: toInt(earliest?.oldScore),
    scoreTo: toInt(newest?.score)
  }
}

/* ------------------------------------------------------------------ 文案 */

/** 名次图标。第 1-3 名有奖牌，其余用纯文字（自走棋前四常被算作「赢」，不特殊处理） */
const CHESS_RANK_ICONS = { 1: '🥇', 2: '🥈', 3: '🥉' }

/** 单局的分数变化片段。拿不到前值就不显示（比硬凑一个「+0」好） */
function chessScoreLine (item) {
  const oldScore = toInt(item?.oldScore)
  const score = toInt(item?.score)
  if (score <= 0) return ''
  if (oldScore > 0 && oldScore !== score) {
    const diff = score - oldScore
    return `分数 ${oldScore} → ${score} (${diff > 0 ? '+' : ''}${diff})`
  }
  return `当前分数 ${score}`
}

/** 单局的名次片段。rank 解析不到时退回 result 的「赢/输」，再不行就空着 */
function chessRankLine (item) {
  const rank = toInt(item?.rank)
  if (rank >= 1) {
    const icon = CHESS_RANK_ICONS[rank] || ''
    return `${icon ? icon + ' ' : ''}第 ${rank} 名`
  }
  if (item?.result === 1) return '🎉 赢了'
  if (item?.result === 2) return '😐 输了'
  return ''
}

/**
 * 一场万象棋战报的文案。
 *
 * 与王者侧三条播报同一约定：**不 @ 本人**（订阅者自己刚打完最清楚，@ 只是多刷
 * 一条红点），名字写进文案里供群友认人。
 *
 * @param {object} item 归一化后的战绩项
 * @param {string} [name] 玩家名（营地昵称，取不到时调用方给群名片兜底）
 */
export function formatChessBattleText (item, name = '') {
  const who = name ? `${normalizeName(name)} · ` : ''
  const rankLine = chessRankLine(item)
  const duration = formatOnlineDuration(item?.durationSec)
  const scoreLine = chessScoreLine(item)

  const head = `♟️ ${who}打完一局万象棋${item?.modeName ? ` · ${item.modeName}` : ''}`
  const detail = [rankLine, duration ? `用时 ${duration}` : '', scoreLine].filter(Boolean).join(' · ')

  return detail ? `${head}\n${detail}` : head
}

/**
 * 多场合并成一条消息（补推/重启后一轮跨了好几局时用）。
 * 每场一行简报，省得刷屏；解析不出名次的场只报「+1 局」。
 *
 * @param {Array<object>} fresh 新场次，从旧到新
 * @param {string} [name] 玩家名
 */
export function buildChessBattleMessage (fresh = [], name = '') {
  const who = name ? `${normalizeName(name)} · ` : ''
  const lines = [`${who}打完 ${fresh.length} 局万象棋`]

  for (const item of fresh.slice(-3)) {
    const parts = [chessRankLine(item), chessScoreLine(item)].filter(Boolean)
    lines.push(`· ${parts.length ? parts.join(' · ') : '（详情拿不到）'}`)
  }
  if (fresh.length > 3) lines.push(`（较早 ${fresh.length - 3} 局略过）`)

  return lines.join('\n')
}

/**
 * 万象棋上线 / 下线提醒文案。同样不 @ 本人、名字进文案。
 *
 * 在线时长必须由调用方拿「自己记下的上线时刻」算好传进来 —— 营地的 offlineTime
 * 在刚下线时不会立刻更新（王者侧实测 1557825900：gameOnline 已 0，
 * offlineTime 仍早于 onlineTime，相减是负数），这个坑大概率在棋侧同样存在。
 *
 * @param {'online'|'offline'} kind
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.gameOnline] 当前状态值（沿用三态，2 显示「已进对局」）
 * @param {number} [opts.durationSec] 本次在线秒数，0 表示算不出来、不显示
 * @param {object} [opts.session] summarizeChessSession 的返回，只在下线时用
 */
export function formatChessOnlineText (kind, { name = '', gameOnline = 0, durationSec = 0, session = null } = {}) {
  const who = name ? `${normalizeName(name)} · ` : ''

  if (kind === 'online') {
    return `🟢 ${who}万象棋已上线${toInt(gameOnline) === 2 ? ' · 已进对局' : ''}`
  }

  const lines = [`⚫ ${who}万象棋已下线`]

  const duration = formatOnlineDuration(durationSec)
  if (duration) lines[0] += ` · 本次在线 ${duration}`

  if (session?.count > 0) {
    const parts = [`打了 ${session.count} 局`]
    if (session.top1 > 0) parts.push(`吃鸡 ${session.top1} 次`)
    if (session.top4 > 0) parts.push(`前四 ${session.top4} 次`)
    lines.push(`🎮 ${parts.join(' · ')}`)

    if (session.scoreFrom > 0 && session.scoreTo > 0 && session.scoreFrom !== session.scoreTo) {
      const diff = session.scoreTo - session.scoreFrom
      lines.push(`📈 棋手分 ${session.scoreFrom} → ${session.scoreTo} (${diff > 0 ? '+' : ''}${diff})`)
    }
  } else if (duration) {
    lines.push('🎮 本次没有战绩记录')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ 轮询节流 */

/**
 * 这一轮要不要花一次战绩列表请求。直接复用王者的 needBattleList：
 * state 已归一化成同名的 gameOnline/onlineTime/offlineTime，
 * sub 用视图对象把 chessLastOnlineState 接到它读的 lastOnlineState 上。
 *
 * @param {object} opts
 * @param {boolean} opts.battleOn 开了棋战绩推送
 * @param {boolean} opts.onlineOn 开了棋上下线提醒（本轮要采在线状态）
 * @param {object|null} opts.state 本轮主页结果
 * @param {object} opts.sub 棋订阅项
 * @returns {boolean}
 */
export function needChessBattleList ({ battleOn, onlineOn, state, sub = {} } = {}) {
  return needBattleList({
    battleOn,
    onlineOn,
    state,
    sub: { lastOnlineState: sub.chessLastOnlineState }
  })
}

/**
 * 这个棋订阅现在算不算「活跃」（决定退避）。复用 isSubActive：
 * state 是归一化形状，data 带 isGaming 与 dtEventTime，直接兼容。
 *
 * @param {object|null} state
 * @param {object|null} data
 * @param {number} nowSec
 * @returns {boolean}
 */
export function isChessSubActive (state, data, nowSec) {
  return isSubActive(state, data, nowSec)
}

/**
 * 算接下来要跳过几轮（退避档位与王者的共用）。返回值直接写回棋订阅项。
 * @returns {{skipTicks:number, idleSince:string}}
 */
export function resolveNextChessCheck (sub, opts = {}) {
  return resolveNextCheck(sub, opts)
}

export {
  diffOnlineState,
  resolveOnlineSince,
  formatOnlineDuration,
  hasOnlineSignal,
  pickNewBattles
}
