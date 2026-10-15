/**
 * 王者万象棋推送：订阅指令 + cron 轮询。
 *
 * 两路推送（打完一局万象棋的战报 / 棋上下线提醒），订阅存独立的 ChessPush.yaml，
 * 与王者推送完全隔离 —— 理由与整体设计见 utils/chessPushStore.js 的文件头。
 *
 * ⚠️⚠️ **万象棋的营地接口是推断端点，未实测**（2026-10）：营地没有公开的万象棋
 *    接口资料，端点路径与返回体字段都是按王者侧推断的。表现：
 *      · 订阅可以正常开启（拉不到基准也允许开，第一轮轮询会自动补基准）；
 *      · 接口没通时不会推任何东西，也**不会推半真半假的数据**（解析不出字段
 *        一律安全降级为「不推」）；
 *      · 校准方式见 chessPushStore.js 文件头（配置端点 + 字段候选表 + debug 形状日志）。
 *
 * 设计要点（与王者推送一致的部分，理由详见 apps/gameRecordPush.js）：
 * - 个人订阅制，只轮询订阅过的人，推到订阅时所在的群；
 * - 播报一律不 @ 本人，玩家名写进文案；
 * - 请求量自适应：离线的号按 skipTicks 退避，频控后安静期 + 探测期；
 * - 请求顺序先 profile 后战绩列表：先拿到在线状态，离线的号省掉那次大返回体请求。
 */
import {
  loadChessList,
  saveChessList,
  mergeChessState,
  mergeChessStates,
  beginChessBatch,
  endChessBatch,
  disableChessFlag,
  isChessFlagOn,
  hasAnyChessFlag,
  sweepChessLeftGroups,
  fetchChessLatest,
  fetchChessOnlineState,
  pickNewChessBattles,
  needChessBattleList,
  isChessSubActive,
  resolveNextChessCheck,
  diffOnlineState,
  resolveOnlineSince,
  hasOnlineSignal,
  summarizeChessSession,
  formatChessBattleText,
  buildChessBattleMessage,
  formatChessOnlineText,
  subGroups,
  withSubGroup,
  withoutSubGroup,
  sleep,
  REQUEST_INTERVAL,
  DEFAULT_IDLE_BACKOFF_MAX,
  FETCH_HIDDEN
} from '../utils/chessPushStore.js'
// 锁 / 游标 / 退避 / 安静期必须跨热重载共享，否则会被热重载架空（见 utils/hotState.js）
import { hotBox } from '../utils/hotState.js'
import { getCurrentId, pickGroupSafe, resolveMemberName, isBlackUser, Button, shouldQuote, ApiService } from '#utils'
import { Config } from '#components'

/**
 * 轮询并发锁 + 游标 + 频控状态。⚠️ 必须锚进 hotBox：模块级 `let` 在热重载后归零，
 * 会让「上一轮还在跑」的重入闸失效、游标从头排（详见 gameRecordPush.js 的 S）。
 */
const S = hotBox('chessRecordPush.state', {
  running: false,
  cursor: 0,
  recoverRounds: 0,
  quietUntil: 0
})

/**
 * 一轮最多真发几次请求。比王者侧（6）小：棋每轮是 profile + 战绩列表两个端点，
 * 而且端点未校准前每个请求都可能白打，预算收紧一档少惹营地。
 */
const MAX_REQUESTS_PER_ROUND = 4

/** 频控恢复期还剩几轮，> 0 时每轮只放一个请求探路 */
const RECOVER_PROBE_ROUNDS = 3

/**
 * 命中频控后的安静期。营地对「刚被限流又立刻回来」有惩罚续期（王者侧实测，
 * 见 gameRecordPush.js 的 RATE_LIMIT_QUIET_MS），棋侧沿用同一套。
 */
const RATE_LIMIT_QUIET_MS = 15 * 60 * 1000

/** 读配置，读不到按空对象处理 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

export class ChessRecordPush extends plugin {
  constructor () {
    super({
      name: '王者万象棋推送',
      dsc: '打完万象棋自动推战报，上下线提醒',
      event: 'message',
      priority: 0,
      rule: [
        { reg: '^#(开启|关闭)(王者)?万象棋战绩推送$', fnc: 'toggleChessBattle' },
        { reg: '^#(开启|关闭)(王者)?万象棋上下线提醒$', fnc: 'toggleChessOnline' },
        { reg: '^#(王者)?万象棋推送(状态|列表)?$', fnc: 'status' },
        { reg: '^#清空(王者)?万象棋推送$', fnc: 'clearAll', permission: 'master' }
      ]
    })

    // 总开关关闭或 cron 留空时给空 task，Yunzai 的 loader 只收集 cron 和 fnc 都有值的项。
    // cron 留空 = 整个万象棋推送停摆（订阅指令仍可用，记录保留）
    const cfg = readConfig()
    this.task = cfg.chessPushCron && cfg.onlineReminder !== false
      ? {
          name: '王者万象棋推送',
          cron: cfg.chessPushCron,
          fnc: () => this.checkChessAll(),
          log: false
        }
      : { name: '', fnc: '', cron: '' }
  }

  /**
   * 开关的公共校验：群里发（推送要群号）、总开关开着、绑过营地ID。
   * @returns {Promise<string>} 通过时返回营地ID，未通过时已经回复过了，返回空串
   */
  async prepareChessToggle (e, label) {
    if (!e.isGroup) {
      await e.reply(`${label}需要在群里开启，提醒会发到你开启时所在的群`, shouldQuote())
      return ''
    }

    if (readConfig().onlineReminder === false) {
      await e.reply('推送总开关当前是关闭状态，请让主人在 #王者设置 里打开', shouldQuote())
      return ''
    }

    // 和王者订阅同一口径：本地固化 campId，共享库那边后来改了值这里也跟不上
    const campId = getCurrentId(e.user_id)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return ''
    }

    return String(campId)
  }

  /** #开启万象棋战绩推送 / #关闭万象棋战绩推送 */
  async toggleChessBattle (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableChessIn(e, qq, 'chessBattle', '万象棋战绩推送')
      return
    }

    const campId = await this.prepareChessToggle(e, '万象棋战绩推送')
    if (!campId) return

    // 立刻拉一次当前最新战绩做基准，第一轮轮询就不会把历史战绩当新的推。
    // ⚠️ 与王者订阅不同：**拉不到也允许开启**。棋的端点还是推断值，接口没通时
    //    拒绝开启会让这个功能在校准前完全不可用；空游标是安全的（pickNewBattles
    //    对空游标返回空数组），第一轮轮询拿到数据时会补种基准（见 checkChessBattle）
    const data = await fetchChessLatest(campId, qq)

    if (data === FETCH_HIDDEN) {
      await e.reply('营地侧暂时取不到你的万象棋数据（该号隐藏了战绩或不存在），请先在营地里检查相关设置', shouldQuote())
      return
    }

    const list = loadChessList()
    const existed = list[qq] || {}
    // 已经开着、只是换个群：只追加推送群，游标一概不动（理由同王者侧 toggle）
    const { groups, group, added } = withSubGroup(existed, e.group_id)
    const wasOn = isChessFlagOn(existed, 'chessBattle') && subGroups(existed).length > 0

    if (wasOn) {
      list[qq] = { ...existed, chessBattle: true, groups, group, campId }
      saveChessList(list)
      await e.reply([
        added
          ? `✅ 本群已加入万象棋战绩推送，现在会推到 ${groups.length} 个群`
          : '万象棋战绩推送本来就在本群开着，无需重复开启',
        Button.push(true)
      ], shouldQuote())
      return
    }

    // 整表重读再合并：上面那次 fetchChessLatest 是真实 HTTP 请求，能挂几秒，
    // 期间别人的订阅改动不能被旧快照覆盖（教训见王者侧 toggle 的 2026-10-06 修复）
    const fresh = loadChessList()
    const base = fresh[qq] || existed
    const merged = withSubGroup(base, e.group_id)

    const latest = (Array.isArray(data?.list) ? data.list : [])[0] || {}
    list[qq] = {
      ...base,
      chessBattle: true,
      groups: merged.groups,
      group: merged.group,
      campId,
      chessLastGameSeq: String(latest.gameSeq || ''),
      chessLastGameTime: String(latest.dtEventTime || ''),
      // 清掉可能残留的退避档位，别让刚开启的订阅干等十分钟才第一次检查
      skipTicks: 0,
      idleSince: '',
      enabledAt: Date.now()
    }
    saveChessList(list)

    const gotBase = Boolean(data)
    await e.reply([
      [
        `✅ 已开启万象棋战绩推送（营地ID ${campId}）`,
        '打完一局会在本群播报（不 @ 你）',
        gotBase ? '' : '⚠️ 这次没能拉到当前战绩做基准（接口未校准或频控），下一轮会自动补',
        '上下线也想一起提醒发 #开启万象棋上下线提醒'
      ].filter(Boolean).join('\n'),
      Button.push(true)
    ], shouldQuote())
  }

  /** #开启万象棋上下线提醒 / #关闭万象棋上下线提醒 */
  async toggleChessOnline (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableChessIn(e, qq, 'chessOnline', '万象棋上下线提醒')
      return
    }

    const campId = await this.prepareChessToggle(e, '万象棋上下线提醒')
    if (!campId) return

    // 立刻拉一次当前状态做基准，第一轮不会把「当前在线」当成刚上线推一条。
    // 拉不到也允许开启（理由见 toggleChessBattle）：diffOnlineState 对空基准
    // 只登记不提醒，下一轮会自然补上基准
    const state = await fetchChessOnlineState(campId, qq)

    if (state === FETCH_HIDDEN) {
      await e.reply('营地侧暂时取不到你的万象棋数据（该号隐藏了主页或不存在），请先在营地里检查相关设置', shouldQuote())
      return
    }

    const list = loadChessList()
    const existed = list[qq] || {}
    const { groups, group, added } = withSubGroup(existed, e.group_id)

    // 已经开着、只是再加个群：不重新拉基准（那会把状态机抹掉重来）
    if (isChessFlagOn(existed, 'chessOnline') && subGroups(existed).length > 0) {
      list[qq] = { ...existed, chessOnline: true, groups, group, campId }
      saveChessList(list)
      await e.reply(
        added
          ? `✅ 本群已加入万象棋上下线提醒，现在会推到 ${groups.length} 个群`
          : '万象棋上下线提醒本来就在本群开着，无需重复开启',
        shouldQuote()
      )
      return
    }

    const fresh = loadChessList()
    const base = fresh[qq] || existed
    const merged = withSubGroup(base, e.group_id)

    // 基准只在「营地真的给了在线信号」时种（三字段全 0 = 营地没说，不能记成 0，
    // 否则这个号的上下线就永远沉默了。口径与王者的 collectSnapshot 一致）
    const hasSignal = state && hasOnlineSignal(state)
    list[qq] = {
      ...base,
      chessOnline: true,
      groups: merged.groups,
      group: merged.group,
      campId,
      ...(hasSignal
        ? { chessLastOnlineState: String(state.gameOnline), chessOnlineSince: state.gameOnline !== 0 ? String(resolveOnlineSince(state.onlineTime, Math.floor(Date.now() / 1000))) : '' }
        : {}),
      skipTicks: 0,
      idleSince: '',
      enabledAt: Date.now()
    }
    saveChessList(list)

    await e.reply(
      added
        ? `✅ 已开启万象棋上下线提醒（营地ID ${campId}），上线、下线都会在本群播报${hasSignal ? '' : '\n⚠️ 这次没能拉到当前状态做基准，下一轮会自动补'}`
        : '万象棋上下线提醒本来就在本群开着，无需重复开启',
      shouldQuote()
    )
  }

  /**
   * 关掉一路棋推送。多群时先摘当前群，摘光了才整个关掉（口径同王者侧 disableIn）
   */
  async disableChessIn (e, qq, key, label) {
    const list = loadChessList()
    const sub = list[qq]

    if (!sub || !isChessFlagOn(sub, key)) {
      await e.reply(`你还没有开启${label}`, shouldQuote())
      return
    }

    const groups = subGroups(sub)
    const here = String(e.group_id || '')

    if (e.isGroup && groups.length > 1 && groups.includes(here)) {
      const { groups: rest, group } = withoutSubGroup(sub, here)
      list[qq] = { ...sub, groups: rest, group }
      saveChessList(list)
      await e.reply(
        `已停止在本群推送${label}，其余 ${rest.length} 个群不变（想全关就在那些群里也发一次）`,
        shouldQuote()
      )
      return
    }

    const { removed } = disableChessFlag(qq, key)
    if (removed) {
      await e.reply(`已关闭${label}`, shouldQuote())
    } else {
      await e.reply(`已关闭${label}（别的推送还开着）`, shouldQuote())
    }
  }

  /** #万象棋推送 / #万象棋推送状态 */
  async status (e) {
    const qq = String(e.user_id)
    const list = loadChessList()
    const sub = list[qq]

    if (!sub || !hasAnyChessFlag(sub)) {
      await e.reply(
        [
          '你还没有订阅万象棋推送，可用的指令：',
          '· #开启万象棋战绩推送 —— 打完一局自动播战报',
          '· #开启万象棋上下线提醒 —— 上线、下线自动播报'
        ].join('\n'),
        shouldQuote()
      )
      return
    }

    const groups = subGroups(sub)
    const cron = readConfig().chessPushCron || ''
    const lines = [
      `营地ID：${sub.campId || '未知'}`,
      `推送群：${groups.join('、')}`,
      `战绩推送：${isChessFlagOn(sub, 'chessBattle') ? '开' : '关'}`,
      `上下线提醒：${isChessFlagOn(sub, 'chessOnline') ? '开' : '关'}`,
      cron ? `检查间隔：最快 ${cron}` : '⚠️ 轮询定时未开启（config 的 chessPushCron 为空），订阅了也暂时不会推'
    ]
    if (sub.lastUnavailableReason) lines.push(`⚠️ ${sub.lastUnavailableReason}`)

    await e.reply(lines.join('\n'), shouldQuote())
  }

  /** #清空万象棋推送（主人） */
  async clearAll (e) {
    const list = loadChessList()
    const count = Object.keys(list).length
    saveChessList({})
    await e.reply(`已清空全部万象棋推送订阅（${count} 个）`, shouldQuote())
  }

  /**
   * 定时轮询。骨架与王者的 checkAll 一致（重入闸 / 退群清理 / 退避 / 预算 /
   * 频控安静期），状态独立、预算独立 —— 棋侧的任何失败都不影响王者推送的节奏。
   */
  async checkChessAll () {
    if (readConfig().onlineReminder === false) return

    // 退群闸门：人退了的群从订阅上摘掉，放在读 entries 之前（口径同王者侧，
    // 判据是实时 gml；拿不到成员缓存时一个人都不动）
    const list = loadChessList()
    const swept = sweepChessLeftGroups(list)
    if (swept.cleared || swept.stopped) {
      logger.mark(`[万象棋推送] 退群清理：摘掉 ${swept.cleared} 个推送群${swept.stopped ? `，停掉 ${swept.stopped} 条订阅` : ''}`)
    }

    // 名单只收开了棋两路之一的人。被拉黑的整条跳过（订阅不删，移出黑名单即恢复）
    const entries = Object.entries(list)
      .filter(([qq, sub]) => !isBlackUser(qq) &&
        (isChessFlagOn(sub, 'chessBattle') || isChessFlagOn(sub, 'chessOnline')))

    // 顺手清空壳（两路全关、也没有群）：避免占轮询名额
    const stale = Object.keys(list)
      .filter(qq => !(list[qq]?.chessBattle === true || list[qq]?.chessOnline === true) &&
        !subGroups(list[qq]).length)
    if (stale.length) {
      for (const qq of stale) delete list[qq]
      saveChessList(list)
      logger.info(`[万象棋推送] 清理 ${stale.length} 条空壳订阅`)
    }

    if (!entries.length) return

    if (S.running) {
      logger.warn(`[万象棋推送] 上一轮还在跑，本轮跳过（${entries.length} 个订阅，间隔可能设得太短）`)
      return
    }

    // 账号池全在冷却时整轮跳过：每个订阅都会被 api 层挡回来，白挨个抛错
    if (ApiService.hasNoAvailableAccount()) {
      logger.debug(`[万象棋推送] 账号池全在频控冷却里，本轮 ${entries.length} 个订阅都不查`)
      return
    }

    if (Date.now() < S.quietUntil) {
      logger.debug(`[万象棋推送] 频控安静期内（还剩 ${Math.ceil((S.quietUntil - Date.now()) / 1000)} 秒），本轮都不查`)
      return
    }

    S.running = true
    const roundStart = Date.now()
    // 恢复期每轮只放一个请求（营地频控有惩罚续期，冷却刚过就全军出击等于立刻再吃一发）
    const budget = S.recoverRounds > 0 ? 1 : MAX_REQUESTS_PER_ROUND
    const total = entries.length
    const from = S.cursor % total
    let sent = 0
    let next = ''
    const skipPatches = []

    try {
      for (let i = 0; i < total; i += 1) {
        const idx = (from + i) % total
        const [qq, sub] = entries[idx]

        // 退避中：递减计数就走，跳过的订阅没发请求，不 sleep
        const skip = Number(sub?.skipTicks) || 0
        if (skip > 0) {
          skipPatches.push([qq, { skipTicks: skip - 1 }])
          continue
        }

        if (sent >= budget) {
          next = idx
          break
        }

        try {
          await this.checkChessOne(qq, sub)
        } catch (error) {
          logger.error(`[万象棋推送] 检查 ${qq} 出错: ${error.message}`)
        }
        sent += 1

        // 这一发撞上频控：剩下的订阅一个都别试了
        if (ApiService.lastRateLimitAt() > roundStart) {
          logger.warn(`[万象棋推送] 本轮命中营地频控，还剩 ${total - i - 1} 个订阅留到下一轮`)
          next = (idx + 1) % total
          break
        }

        await sleep(REQUEST_INTERVAL)
      }
    } finally {
      // 退避计数先落盘（异常路径也不能漏：漏了等于把自适应节流整个关掉）
      if (skipPatches.length) {
        try {
          mergeChessStates(skipPatches)
        } catch (error) {
          logger.error(`[万象棋推送] 写退避计数失败: ${error.message}`)
        }
      }
      S.running = false
      S.cursor = next === '' ? 0 : next
      if (ApiService.lastRateLimitAt() > roundStart) {
        S.quietUntil = Date.now() + RATE_LIMIT_QUIET_MS
        S.recoverRounds = RECOVER_PROBE_ROUNDS
        logger.warn(`[万象棋推送] 命中营地频控：安静 ${Math.round(RATE_LIMIT_QUIET_MS / 60000)} 分钟，之后 ${RECOVER_PROBE_ROUNDS} 轮每轮只探一个订阅`)
      } else if (S.recoverRounds > 0) {
        S.recoverRounds -= 1
      }
    }
  }

  /**
   * 检查单个订阅：先 profile（在线状态），值得时再拉战绩列表。
   *
   * 先 profile 的理由同王者侧：返回体小一个量级，离线的号省掉战绩列表那次请求。
   * 本轮对这条订阅的所有写入攒成一批，结束时一次落盘（beginChessBatch / endChessBatch）。
   */
  async checkChessOne (qq, sub) {
    // 没有推送目标群就不用轮询
    if (!subGroups(sub).length) return

    // 营地ID 动态取，不锁死在订阅时那个：用户 #切换营地 后跟着换
    const campId = getCurrentId(qq)
    if (!campId) {
      logger.debug(`[万象棋推送] ${qq} 已解绑营地ID，跳过`)
      return
    }

    beginChessBatch()
    try {
      await this.checkChessOneInner(qq, sub, String(campId))
    } finally {
      try {
        endChessBatch()
      } catch (error) {
        logger.error(`[万象棋推送] 落盘 ${qq} 的订阅状态失败: ${error.message}`)
      }
    }
  }

  /** checkChessOne 的实际逻辑。外面那层只管把写入攒成一批落盘 */
  async checkChessOneInner (qq, sub, campId) {
    const battleOn = isChessFlagOn(sub, 'chessBattle')
    const onlineOn = isChessFlagOn(sub, 'chessOnline')
    const nowSec = Math.floor(Date.now() / 1000)

    let state = null
    let unavailable = false

    if (onlineOn) {
      state = await fetchChessOnlineState(campId, qq)
      if (state === FETCH_HIDDEN) {
        unavailable = true
        state = null
      }
    }

    // 主页顺带给玩家名，缓存给文案用（战绩列表里没有这个名字）
    const roleName = state?.roleName ? String(state.roleName) : ''
    if (roleName && roleName !== sub.roleName) {
      mergeChessState(qq, { roleName })
    }

    let data = null
    if (needChessBattleList({ battleOn, onlineOn, state, sub })) {
      // 两个端点的请求别贴在一起（同王者侧）
      if (onlineOn) await sleep(REQUEST_INTERVAL)
      const fetched = await fetchChessLatest(campId, qq)
      if (fetched === FETCH_HIDDEN) {
        unavailable = true
      } else {
        data = fetched
      }
    }

    // ⭐ 营地明确说取不到：写进订阅项，这是排查「推送怎么没了」的唯一线索
    if (unavailable) {
      const lastAt = Number(sub?.lastUnavailableAt) || 0
      if (Date.now() - lastAt > 60 * 60 * 1000) {
        logger.mark(`[万象棋推送] ${qq} 的营地 ${campId} 营地侧取不到数据（隐藏/不存在），这一路暂时推不了`)
      }
      mergeChessState(qq, {
        lastUnavailableAt: String(Date.now()),
        lastUnavailableReason: `营地号 ${campId} 取不到数据（隐藏/不存在）`
      })
    } else if (sub?.lastUnavailableAt) {
      mergeChessState(qq, { lastUnavailableAt: '', lastUnavailableReason: '' })
    }

    if (battleOn && data) {
      await this.checkChessBattle(qq, sub, data)
    }

    if (onlineOn) {
      await this.checkChessOnline(qq, sub, data, state, nowSec)
    }

    // 收尾：按这一轮的活跃度定接下来跳过几轮（退避档位与王者共用）
    const active = isChessSubActive(state, data, nowSec)
    const next = resolveNextChessCheck(sub, {
      active,
      nowMs: Date.now(),
      maxMultiplier: readConfig().idleBackoffMax ?? DEFAULT_IDLE_BACKOFF_MAX
    })
    mergeChessState(qq, {
      skipTicks: next.skipTicks,
      idleSince: next.idleSince,
      // 诊断字段：最后一次成功拿到数据的时刻
      ...(data || state ? { lastSeenAt: String(Date.now()) } : {})
    })
  }

  /**
   * 战绩推送：有新场次就播战报。
   *
   * 空游标兜底：订阅时没能拉到基准（接口未校准 / 频控）的订阅，游标是空的，
   * 第一轮拿到数据时把游标种到当前最新 —— 只登记、不把历史战绩翻出来推
   *（与王者侧「订阅时正在打的局不提醒」同一口径）。
   */
  async checkChessBattle (qq, sub, data) {
    const list = Array.isArray(data.list) ? data.list : []
    const fresh = pickNewChessBattles(list, sub)

    // 空游标补种基准（不改订阅开关，只写游标）
    if (!String(sub.chessLastGameSeq || '') && !Number(sub.chessLastGameTime)) {
      const latest = list[0] || {}
      mergeChessState(qq, {
        chessLastGameSeq: String(latest.gameSeq || ''),
        chessLastGameTime: String(latest.dtEventTime || '')
      })
      return
    }

    if (!fresh.length) return

    const name = await this.resolveDisplayName(qq, sub)
    const text = fresh.length === 1
      ? formatChessBattleText(fresh[0], name)
      : buildChessBattleMessage(fresh, name)

    const sent = await this.send(qq, sub, text)
    if (!sent) return

    // 发送失败时游标不动，下一轮整条消息重试
    const newest = fresh[fresh.length - 1]
    mergeChessState(qq, {
      chessLastGameSeq: String(newest.gameSeq || ''),
      chessLastGameTime: String(newest.dtEventTime || '')
    })
  }

  /**
   * 上下线提醒：只在「离线 <-> 非离线」跨越时发，1<->2 抖动不发（口径与王者一致，
   * 万象棋与王者共用账号与客户端，这个抖动形态大概率相同）。
   */
  async checkChessOnline (qq, sub, data, state, nowSec) {
    if (!state) return

    // 营地没给在线信号（三字段全 0）：不能记成 0，否则上下线永远沉默
    if (!hasOnlineSignal(state)) return

    const kind = diffOnlineState(state.gameOnline, sub.chessLastOnlineState)

    if (!kind) {
      // 状态没跨越，只登记。已经在线但没有上线时刻的，补一个基准
      const patch = { chessLastOnlineState: String(state.gameOnline) }
      if (state.gameOnline !== 0 && !sub.chessOnlineSince) {
        patch.chessOnlineSince = String(resolveOnlineSince(state.onlineTime, nowSec))
      }
      mergeChessState(qq, patch)
      return
    }

    const name = state.roleName || await this.resolveDisplayName(qq, sub)

    let text
    if (kind === 'online') {
      text = formatChessOnlineText('online', { name, gameOnline: state.gameOnline })
    } else {
      // 在线时长用自己记的上线时刻算（营地的 offlineTime 刚下线时不立刻更新）
      const since = Number(sub.chessOnlineSince) || 0
      text = formatChessOnlineText('offline', {
        name,
        durationSec: since > 0 ? nowSec - since : 0,
        session: since > 0 && data ? summarizeChessSession(data.list, since) : null
      })
    }

    const sent = await this.send(qq, sub, text)
    if (!sent) return

    mergeChessState(qq, {
      chessLastOnlineState: String(state.gameOnline),
      // 上线时记下时刻供下次下线算时长；下线时清空
      chessOnlineSince: kind === 'online' ? String(resolveOnlineSince(state.onlineTime, nowSec, true)) : ''
    })
  }

  /**
   * 往订阅的每个群发一条推送（纯文字）。
   * 多群时只要有一个群发成功就算成功（游标推进的口径同王者侧）。
   * @returns {Promise<boolean>}
   */
  async send (qq, target, text) {
    const groups = Array.isArray(target)
      ? target.map(String)
      : (typeof target === 'object' && target !== null ? subGroups(target) : subGroups({ group: target }))

    if (!groups.length) {
      logger.debug(`[万象棋推送] ${qq} 没有推送群，跳过`)
      return false
    }

    let ok = 0
    for (const groupId of groups) {
      try {
        const group = pickGroupSafe(groupId)
        if (!group?.sendMsg) {
          logger.warn(`[万象棋推送] 取不到群 ${groupId}，跳过 ${qq}`)
          continue
        }

        await group.sendMsg([text])
        ok += 1
        logger.mark(`[万象棋推送] 已推送给 ${qq}@群${groupId}`)
      } catch (error) {
        logger.error(`[万象棋推送] 发送失败 ${qq}@群${groupId}: ${error.message}`)
      }
    }

    return ok > 0
  }

  /**
   * 拿玩家名写进文案（每条播报都不 @ 本人，名字是群里认人的唯一线索）。
   * 订阅项里缓存一份（主页每轮顺手更新），一次都没拿到过时退回群名片/昵称。
   */
  async resolveDisplayName (qq, sub) {
    if (sub?.roleName) return String(sub.roleName)
    return resolveMemberName(pickGroupSafe(subGroups(sub)[0]), qq)
  }
}
