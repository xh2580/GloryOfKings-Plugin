/**
 * 万象棋推送（utils/chessPushStore.js / apps/chessRecordPush.js）的回归测试。
 *
 * 手法同 auditFixes.test.mjs：入口模块 import 了框架（#utils 的 ApiService、
 * #components 的 Config），直接 import 会抛，所以读源码抽函数 + `new Function` 跑。
 * 抽出来的都是纯计算（解析 / 文案 / 游标），桩只补 logger / normalizeName / toInt。
 *
 * 每条用例都标了「防什么回归」——这个模块整体建立在推断上（见 chessPushStore
 * 文件头），测试钉住的是**推断的形状约定**：
 *   · 归一化输出必须对齐王者侧字段名（gameSeq/dtEventTime/isGaming），
 *     pushStore 的 pickNewBattles / isSubActive 才能直接吃 —— 字段名一变就是静默失效；
 *   · 解析不出字段时安全降级为空，绝不能抛错或编造数据。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = path.resolve(HERE, '..')

const read = f => fs.readFileSync(path.join(P, f), 'utf8')

/**
 * 抽出一个 `function name (` 声明（自动剥掉 export 前缀）。
 * ⚠️ 签名里可能带解构参数（`function f (kind, { a = 0 } = {})`），所以必须先把
 * 参数列表的**圆括号**配平、再从函数体的 `{` 开始配大括号 —— 直接找第一个 `{`
 * 会在解构参数的 `}` 处提前截断（formatChessOnlineText 就是这样炸的）。
 */
function extractFunction (source, name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) return null
  const openParen = source.indexOf('(', start)
  let depth = 0
  let sigEnd = -1
  for (let j = openParen; j < source.length; j++) {
    if (source[j] === '(') depth++
    else if (source[j] === ')') { depth--; if (!depth) { sigEnd = j; break } }
  }
  if (sigEnd < 0) return null

  const bodyStart = source.indexOf('{', sigEnd)
  depth = 0
  for (let j = bodyStart; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  return null
}

/** 抽出一个 `const NAME = ...`（对象字面量，到配对大括号为止） */
function extractConst (source, name) {
  const start = source.indexOf(`const ${name} = `)
  if (start < 0) return null
  const i = source.indexOf('{', start)
  let depth = 0
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  return null
}

const STUBS = `
  const logger = { debug () {}, mark () {}, info () {}, warn () {}, error () {} }
  const normalizeName = n => String(n || '').trim()
  const toInt = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
  // pushStore 的时长格式化，文案函数引用它（秒 -> 「45分钟」）
  const formatOnlineDuration = seconds => {
    const total = toInt(seconds)
    if (total <= 0) return ''
    const hours = Math.floor(total / 3600)
    const mins = Math.floor((total % 3600) / 60)
    if (hours > 0) return mins > 0 ? hours + '小时' + mins + '分' : hours + '小时'
    return mins > 0 ? mins + '分钟' : '不到1分钟'
  }
`

/** chessPushStore 的纯计算合集，一次抽出反复用 */
function buildChessApi () {
  const src = read('utils/chessPushStore.js')
  const parts = [
    extractConst(src, 'CHESS_FIELDS'),
    extractConst(src, 'CHESS_ROLE_FIELDS'),
    extractConst(src, 'CHESS_RANK_ICONS'),
    extractFunction(src, 'pickField'),
    extractFunction(src, 'logShape'),
    extractFunction(src, 'chessScoreLine'),
    extractFunction(src, 'chessRankLine'),
    extractFunction(src, 'normalizeChessBattles'),
    extractFunction(src, 'normalizeChessOnlineState'),
    extractFunction(src, 'summarizeChessSession'),
    extractFunction(src, 'formatChessBattleText'),
    extractFunction(src, 'buildChessBattleMessage'),
    extractFunction(src, 'formatChessOnlineText')
  ]
  assert.ok(parts.every(Boolean), 'chessPushStore 的待测函数全部要能抽出来，抽不出说明改名了')
  const body = `${STUBS}\n${parts.join('\n')}\n
    return { normalizeChessBattles, normalizeChessOnlineState, summarizeChessSession,
      formatChessBattleText, buildChessBattleMessage, formatChessOnlineText }`
  return new Function(body)()
}

const chess = buildChessApi()

/* ════════════════════════════════════════════════ 归一化：战绩列表 ══════════════════════════════════════════════ */

describe('normalizeChessBattles：推断形状（王者同构）', () => {
  it('王者形状的返回体能归一化出 gameSeq/dtEventTime/rank', () => {
    const res = {
      returnCode: 0,
      data: {
        list: [
          { gameSeq: '2001', dtEventTime: 1700000300, rank: 1, usedTime: 1500, mapName: '经典模式', score: 1250, oldScore: 1235 },
          { gameSeq: '2000', dtEventTime: 1700000000, rank: 5, gameresult: 2, usedTime: 1800, score: 1235, oldScore: 1240 }
        ],
        gaming: { isGaming: false, dtEventTime: 0, mapName: '' }
      }
    }
    const out = chess.normalizeChessBattles(res)
    assert.equal(out.list.length, 2)
    assert.equal(out.list[0].gameSeq, '2001')
    assert.equal(out.list[0].dtEventTime, 1700000300)
    assert.equal(out.list[0].rank, 1)
    assert.equal(out.list[0].durationSec, 1500)
    assert.equal(out.list[0].modeName, '经典模式')
    assert.equal(out.list[0].score, 1250)
    assert.equal(out.list[1].rank, 5)
    assert.equal(out.isGaming, false)
  })

  it('gaming.isGaming 会被提到顶层（isSubActive 读 data.isGaming）', () => {
    const res = {
      returnCode: 0,
      data: { list: [], gaming: { isGaming: true, dtEventTime: 1700000100, mapName: '经典模式' } }
    }
    const out = chess.normalizeChessBattles(res)
    assert.equal(out.isGaming, true)
    assert.equal(out.gaming.dtEventTime, 1700000100)
  })

  it('battleList 作为 list 的备选字段名也能认（候选表第二位）', () => {
    const res = { returnCode: 0, data: { battleList: [{ gameSeq: '1', dtEventTime: 10, rank: 2 }] } }
    const out = chess.normalizeChessBattles(res)
    assert.equal(out.list.length, 1)
    assert.equal(out.list[0].rank, 2)
  })

  it('⚠️ 字段全不认识时安全降级：list 为空、不抛错（推断落空的表现就是「不推」）', () => {
    const res = { returnCode: 0, data: { foo: [{ bar: 1 }], baz: 'x' } }
    const out = chess.normalizeChessBattles(res)
    assert.deepEqual(out.list, [])
    assert.equal(out.isGaming, false)
  })

  it('data 缺失 / 非对象时不抛错', () => {
    assert.deepEqual(chess.normalizeChessBattles({ returnCode: 0 }).list, [])
    assert.deepEqual(chess.normalizeChessBattles({}).list, [])
    assert.deepEqual(chess.normalizeChessBattles(null).list, [])
  })
})

/* ════════════════════════════════════════════════ 归一化：在线状态 ══════════════════════════════════════════════ */

describe('normalizeChessOnlineState：两种推断形状', () => {
  it('roleList 形状（按王者 profile 推断的主形状）', () => {
    const res = {
      returnCode: 0,
      data: {
        targetRoleId: 'r1',
        roleList: [
          { roleId: 'r2', gameOnline: 0, roleName: '小号' },
          { roleId: 'r1', gameOnline: 2, onlineTime: 100, offlineTime: 90, roleName: '棋圣' }
        ]
      }
    }
    const out = chess.normalizeChessOnlineState(res)
    // 主角色按 targetRoleId 挑，多角色账号不能拿第一个糊弄
    assert.equal(out.gameOnline, 2)
    assert.equal(out.roleName, '棋圣')
    assert.equal(out.onlineTime, 100)
  })

  it('data 平铺形状（万象棋专区查「棋手」，可能不带 roleList）', () => {
    const res = { returnCode: 0, data: { gameOnline: 1, onlineTime: 200, roleName: '棋手乙' } }
    const out = chess.normalizeChessOnlineState(res)
    assert.equal(out.gameOnline, 1)
    assert.equal(out.roleName, '棋手乙')
  })

  it('⚠️ 字段全不认识时三字段归 0（hasOnlineSignal 会判「没信号」，不会谎报离线）', () => {
    const out = chess.normalizeChessOnlineState({ returnCode: 0, data: { xyz: 1 } })
    assert.equal(out.gameOnline, 0)
    assert.equal(out.roleName, '')
    assert.deepEqual(Object.keys(out).sort(), ['gameOnline', 'offlineTime', 'onlineTime', 'roleName'])
  })
})

/* ════════════════════════════════════════════════ 收工总结 ══════════════════════════════════════════════ */

describe('summarizeChessSession：名次口径', () => {
  const list = [
    { gameSeq: '3', dtEventTime: 3000, rank: 1, score: 1250, oldScore: 1235 },
    { gameSeq: '2', dtEventTime: 2000, rank: 5, score: 1235, oldScore: 1240 },
    { gameSeq: '1', dtEventTime: 1000, rank: 2, score: 1240, oldScore: 1230 }
  ]

  it('只统计 since 之后的场次；吃鸡/前四/分数首尾', () => {
    const s = chess.summarizeChessSession(list, 1500)
    assert.equal(s.count, 2)
    assert.equal(s.top1, 1)
    assert.equal(s.top4, 1, 'rank=5 的那局不该进前四')
    // scoreFrom 取窗口内最早一场的**对局前**分（1240 = seq2 的 oldScore），
    // 这才是「本次上线时的分」；取成它打完后的 1235 会把第一局的涨跌吃掉
    assert.equal(s.scoreFrom, 1240)
    assert.equal(s.scoreTo, 1250)
  })

  it('since=0 时不统计任何场次（上线时刻拿不到就不带总结）', () => {
    const s = chess.summarizeChessSession(list, 0)
    assert.equal(s.count, 0)
    assert.equal(s.top1, 0)
  })

  it('名次解析不出来的场只进 count，不进 top1/top4', () => {
    const s = chess.summarizeChessSession([{ gameSeq: '9', dtEventTime: 5000, rank: 0, result: 1 }], 1)
    assert.equal(s.count, 1)
    assert.equal(s.top1, 0)
    assert.equal(s.top4, 0)
  })
})

/* ════════════════════════════════════════════════ 文案 ══════════════════════════════════════════════ */

describe('播报文案：三条播报都不 @ 本人，名字写进文案', () => {
  it('战报：吃鸡带奖牌、分数变化、用时', () => {
    const text = chess.formatChessBattleText(
      { gameSeq: '1', dtEventTime: 1, rank: 1, modeName: '经典', durationSec: 900, score: 1250, oldScore: 1235 },
      '棋手甲'
    )
    assert.ok(text.includes('棋手甲 · 打完一局万象棋 · 经典'), text)
    assert.ok(text.includes('🥇 第 1 名'), text)
    assert.ok(text.includes('用时 15分钟'), text)
    assert.ok(text.includes('分数 1235 → 1250 (+15)'), text)
    assert.ok(!text.includes('@'), '播报不 @ 本人')
  })

  it('战报：rank 解析不到时退回 result 的赢/输；什么都拿不到就不带详情行', () => {
    assert.ok(chess.formatChessBattleText({ gameSeq: '1', result: 1 }, '甲').includes('🎉 赢了'))
    assert.ok(chess.formatChessBattleText({ gameSeq: '1', result: 2 }, '甲').includes('😐 输了'))
    const bare = chess.formatChessBattleText({ gameSeq: '1' }, '甲')
    assert.ok(bare.includes('打完一局万象棋'))
    assert.equal(bare.split('\n').length, 1, '没有任何详情时只有标题一行')
  })

  it('多局合并：只细列最近 3 场，更早的折叠成数量', () => {
    const fresh = [
      { gameSeq: '1', dtEventTime: 1, rank: 2, score: 1200, oldScore: 1190 },
      { gameSeq: '2', dtEventTime: 2, rank: 1, score: 1215, oldScore: 1200 },
      { gameSeq: '3', dtEventTime: 3, rank: 4, score: 1220, oldScore: 1215 },
      { gameSeq: '4', dtEventTime: 4, rank: 1, score: 1240, oldScore: 1220 }
    ]
    const text = chess.buildChessBattleMessage(fresh, '棋手丙')
    assert.ok(text.includes('棋手丙 · 打完 4 局万象棋'), text)
    // slice(-3) 保留的是最新的三场（rank 1/4/1），最早那场（第 2 名）被折叠
    assert.ok(text.includes('（较早 1 局略过）'), text)
    assert.ok(text.includes('🥇 第 1 名'), text)
    assert.ok(text.includes('第 4 名'), text)
    assert.ok(!text.includes('🥈'), '最早那场不该出现在细列里')
  })

  it('上下线文案：上线带状态细分，下线带时长与收工总结', () => {
    assert.equal(chess.formatChessOnlineText('online', { name: '棋手丁', gameOnline: 1 }), '🟢 棋手丁 · 万象棋已上线')
    assert.equal(chess.formatChessOnlineText('online', { name: '棋手丁', gameOnline: 2 }), '🟢 棋手丁 · 万象棋已上线 · 已进对局')

    const off = chess.formatChessOnlineText('offline', {
      name: '棋手丁',
      durationSec: 2700,
      session: { count: 2, top1: 1, top4: 1, scoreFrom: 1235, scoreTo: 1250 }
    })
    assert.ok(off.includes('⚫ 棋手丁 · 万象棋已下线 · 本次在线 45分钟'), off)
    assert.ok(off.includes('打了 2 局 · 吃鸡 1 次 · 前四 1 次'), off)
    assert.ok(off.includes('棋手分 1235 → 1250 (+15)'), off)
  })

  it('下线但没打（无战绩、有时长）：只报一句「本次没有战绩记录」', () => {
    const off = chess.formatChessOnlineText('offline', { name: '棋手戊', durationSec: 600, session: { count: 0 } })
    assert.ok(off.includes('本次没有战绩记录'), off)
  })
})

/* ════════════════════════════════════════════════ 游标：与 pushStore.pickNewBattles 的配合 ══════════════════════════════════════════════ */

describe('pickNewChessBattles：视图字段必须接对（接错 = 永不推送或狂推历史）', () => {
  // pushStore 的 pickNewBattles 原样抽出（带模块级 toInt 桩）
  const pickNewBattles = new Function(
    `${STUBS}\n${extractFunction(read('utils/pushStore.js'), 'pickNewBattles')}\nreturn pickNewBattles`
  )()
  const pickNewChessBattles = new Function(
    'pickNewBattles',
    `${STUBS}\n${extractFunction(read('utils/chessPushStore.js'), 'pickNewChessBattles')}\nreturn pickNewChessBattles`
  )(pickNewBattles)

  const list = [
    { gameSeq: '103', dtEventTime: 3000 },
    { gameSeq: '102', dtEventTime: 2000 },
    { gameSeq: '101', dtEventTime: 1000 }
  ]

  it('游标存的是棋字段（chessLastGameSeq/chessLastGameTime），视图要接进 pickNewBattles', () => {
    const sub = { chessLastGameSeq: '102', chessLastGameTime: 2000 }
    const fresh = pickNewChessBattles(list, sub)
    assert.equal(fresh.length, 1)
    assert.equal(fresh[0].gameSeq, '103', '返回从旧到新')
  })

  it('空游标返回空数组（订阅时没拉到基准的第一轮不推历史）', () => {
    assert.deepEqual(pickNewChessBattles(list, {}), [])
  })

  it('最新一场就是游标 → 无新战绩', () => {
    assert.deepEqual(pickNewChessBattles(list, { chessLastGameSeq: '103', chessLastGameTime: 3000 }), [])
  })
})

/* ════════════════════════════════════════════════ 接线静态断言 ══════════════════════════════════════════════ */

describe('接线：配置、指令、数据文件、端点', () => {
  it('config 模板有三个新键（锅巴与文档依赖它们存在）', () => {
    const cfg = read('config/default_config/config.yaml')
    for (const key of ['chessPushCron', 'chessProfileApi', 'chessBattleApi']) {
      assert.ok(new RegExp(`^${key}:`, 'm').test(cfg), `config.yaml 缺 ${key}`)
    }
  })

  it('api.js 有推断端点常量与两个接口方法', () => {
    const src = read('utils/api.js')
    assert.ok(src.includes('CHESS_DEFAULT_PROFILE_ENDPOINT'), '缺主页端点常量')
    assert.ok(src.includes('CHESS_DEFAULT_BATTLE_ENDPOINT'), '缺战绩端点常量')
    assert.ok(/async getChessProfile \(/.test(src), '缺 getChessProfile')
    assert.ok(/async getChessBattleList \(/.test(src), '缺 getChessBattleList')
    // 端点缺省值是推断值，注释必须写在常量**前面**且说清楚 —— 防止后人当成实测事实
    const idx = src.indexOf('const CHESS_DEFAULT_PROFILE_ENDPOINT')
    assert.ok(idx > 0)
    const head = src.slice(Math.max(0, idx - 800), idx)
    assert.ok(head.includes('推断'), '端点常量的注释里必须标明「推断」')
  })

  it('chessRecordPush.js 注册了全部四条指令', () => {
    const src = read('apps/chessRecordPush.js')
    for (const fnc of ['toggleChessBattle', 'toggleChessOnline', 'status', 'clearAll']) {
      assert.ok(new RegExp(`fnc: '${fnc}'`).test(src), `rule 缺 ${fnc}`)
    }
    // 轮询 task 必须由 chessPushCron 控制，cron 留空时注册空 task
    assert.ok(src.includes('cfg.chessPushCron'), 'task 没有受 chessPushCron 控制')
  })

  it('index.js 注册了 ChessPush.yaml，且和王者订阅表一样带 pushList 骨架', () => {
    const src = read('index.js')
    assert.ok(src.includes('ChessPush.yaml'), 'index.js 没注册 chessPushFile')
    assert.ok(src.includes("key === 'chessPushFile'"), 'chessPushFile 没进 pushList 骨架的判断')
  })

  it('订阅存取全部落在 ChessPush.yaml（与王者表隔离，不许混写 GameRecordPush.yaml）', () => {
    const src = read('utils/chessPushStore.js')
    assert.ok(src.includes("path.join(PluginData, 'ChessPush.yaml')"))
    // 判代码引用，判字符串整体（文件头注释里提到 GameRecordPush.yaml 是说明隔离设计，允许）
    assert.ok(!src.includes("path.join(PluginData, 'GameRecordPush.yaml')"), 'chessPushStore 不该读写王者的订阅表')
    assert.ok(!/savePushList|loadPushList|mergeSubState/.test(src.replace(/\/\/.*$/gm, '')), 'chessPushStore 不该复用王者表的读写函数')
  })
})
