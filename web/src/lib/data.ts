export const MARKETS = ['北美', '欧洲', '东南亚', '中东', '拉美', '日韩']
export const LANGUAGES = ['英语', '西班牙语', '葡萄牙语', '印尼语', '泰语', '阿拉伯语', '日语']

export type ScriptStatus = 'on' | 'off' | 'draft'
export interface Episode {
  title: string
  text: string
}
export interface PricePoint {
  price: number
  at: string
  note: string
}
export interface Script {
  id: string
  title: string
  enTitle: string
  logline: string
  synopsis: string
  cover: string
  tags: string[]
  markets: string[]
  audience: '女频' | '男频'
  language: string
  totalEpisodes: number
  trialCount: number
  episodes: Episode[]
  price: number
  status: ScriptStatus
  sales: number
  rating: number
  createdAt: string
  fileName?: string
  fileSize?: number
  /** 买断剧本是否已被买走（服务端计算） */
  buyoutSold?: boolean
  /** 剧本质量等级（单选标签），取自「剧本质量」分类 */
  quality: string
  /** 销售方式，后台设置 */
  saleType: SaleType
  /** 后台自建标签分类下的标签：分类 id → 标签名 */
  extra: Record<string, string[]>
  priceHistory: PricePoint[]
}

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'closed'
export const STATUS_LABEL: Record<OrderStatus, string> = { pending: '待支付', paid: '已支付', refunded: '已退款', closed: '已关闭' }

export interface Order {
  id: string
  scriptId: string
  scriptTitle: string
  cover: string
  saleType: SaleType
  /** 下单账号（邮箱） */
  account?: string
  original: number
  paid: number
  discounts: { label: string; amount: number }[]
  buyer: string
  company: string
  email: string
  country?: string
  payMethod: string
  /** 支付渠道（ZPay）：alipay / wxpay */
  payChannel?: 'alipay' | 'wxpay'
  /** 网关交易号 */
  tradeNo?: string
  paidAt?: string
  closedNote?: string
  createdAt: string
  status: OrderStatus
  mine: boolean
}

/** 销售方式：批发可多次出售；买断一次性卖出，售出后其他买家不可再购买 */
export type SaleType = 'wholesale' | 'buyout'
export const SALE_LABEL: Record<SaleType, string> = { wholesale: '批发试用', buyout: '买断生产' }
export const PRICE_LABEL: Record<SaleType, string> = { wholesale: '试用价', buyout: '买断价' }
/** 两种销售方式面向买家的说明 */
export const SALE_NOTE: Record<SaleType, { short: string; long: string }> = {
  wholesale: { short: '适合自己折腾、试玩', long: '更适合自己研究、试拍、练手的玩法。同一部剧本会卖给多位买家，不适合直接拿去做正式生产。' },
  buyout: { short: '买下后独家使用', long: '适合正式投入生产。买下后这部剧本归你独家使用，不会再卖给其他人。' },
}

/** 买断剧本是否已被买走：须仍是买断售卖 + 服务端标记；改成批发后不再显示已买断 */
export const isBuyoutSold = (s: Pick<Script, 'buyoutSold' | 'saleType'>) => s.saleType === 'buyout' && s.buyoutSold === true

export interface TagGroup {
  id: string
  name: string
  mode: 'single' | 'multi'
  /** 内置分类：不可删除，前台筛选与剧本字段直接依赖 */
  system?: boolean
  desc?: string
  tags: string[]
}

export const DEFAULT_GROUPS: TagGroup[] = [
  { id: 'quality', name: '剧本质量', mode: 'single', system: true, desc: '内部质量分级，每部剧本只能有一个等级，前台展示并可按等级筛选', tags: ['S 顶级精品', 'A 优质', 'B 良好', 'C 基础', 'D 特价'] },
  { id: 'plot', name: '情节标签', mode: 'multi', system: true, desc: '桥段、人设、爽点等关键词，可多选，用于前台书架筛选与搜索', tags: ['契约婚姻', '先婚后爱', '打脸', '豪门', '命定伴侣', '血脉觉醒', '追妻火葬场', '重生', '大女主', '爽文', '宫廷权谋', '女帝', '史诗', '双胞胎', '反转', '高智商', '隐藏身份', '逆袭', '男频爆款', '娱乐圈', '反击', '古堡', '时空书信', '哥特', '穿书', '反派攻略', '轻喜剧'] },
  { id: 'market', name: '目标市场', mode: 'multi', system: true, desc: '适合发行的海外市场，买家可按市场筛选', tags: [...MARKETS] },
]

/** 评级建议价（管理员可手动改，仅作默认 / 快捷填充） */
export const GRADE_SUGGEST_PRICE: Record<string, number> = {
  S: 1099,
  A: 599,
  B: 199,
  C: 99,
  D: 19.9,
}

export function suggestPrice(quality: string): number {
  const g = qualityGrade(quality)
  return GRADE_SUGGEST_PRICE[g] ?? GRADE_SUGGEST_PRICE.B
}

export function qualityLabel(gradeOrTag: string): string {
  const g = qualityGrade(gradeOrTag)
  const hit = DEFAULT_GROUPS.find((x) => x.id === 'quality')?.tags.find((t) => t.startsWith(g))
  return hit || (g ? `${g} 未命名` : '')
}

/** 读取剧本在某个标签分类下的标签 */
export function getVals(s: Script, gid: string): string[] {
  if (gid === 'plot') return s.tags
  if (gid === 'market') return s.markets
  if (gid === 'quality') return s.quality ? [s.quality] : []
  return s.extra?.[gid] ?? []
}
export function setVals(s: Script, gid: string, v: string[]): Script {
  if (gid === 'plot') return { ...s, tags: v }
  if (gid === 'market') return { ...s, markets: v }
  if (gid === 'quality') return { ...s, quality: v[0] ?? '' }
  return { ...s, extra: { ...(s.extra ?? {}), [gid]: v } }
}

export const qualityGrade = (q: string) => q.trim().charAt(0).toUpperCase()
export const QUALITY_STYLE: Record<string, string> = {
  S: 'bg-amber-50 text-amber-700 ring-amber-200',
  A: 'bg-brand-50 text-brand-700 ring-brand-200',
  B: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  C: 'bg-slate-100 text-ink-600 ring-slate-200',
  D: 'bg-orange-50 text-orange-700 ring-orange-200',
}

/** 金额显示：整数不带小数，有小数保留两位，与网关实付金额一致 */
export const money = (n: number) => {
  const v = Number(n || 0)
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}
export const uid = (p: string) => p + Math.random().toString(36).slice(2, 8)
export const dayStr = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10)
export const today = () => dayStr(0)

export interface Quote {
  base: number
  lines: { label: string; amount: number }[]
  total: number
}

export function quote(s: Script): Quote {
  // 与服务端实付金额保持两位小数一致，避免前端显示 ¥13、网关实际收 ¥12.50
  const base = Math.round(Number(s.price || 0) * 100) / 100
  return { base, lines: [], total: base }
}

/** 将上传的 txt 剧本按「第 N 集」切分 */
export function parseEpisodes(raw: string): Episode[] {
  const lines = raw.replace(/\r/g, '').split('\n')
  const head = /^\s*第\s*([0-9一二三四五六七八九十百零]+)\s*集\s*[：:·\-\s]*(.*)$/
  const eps: Episode[] = []
  let cur: Episode | null = null
  for (const line of lines) {
    const m = line.match(head)
    if (m) {
      cur = { title: m[2].trim() || `第${m[1]}集`, text: '' }
      eps.push(cur)
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line
    }
  }
  if (!eps.length && raw.trim()) return [{ title: '第1集', text: raw.trim() }]
  return eps.map((e) => ({ ...e, text: e.text.trim() }))
}

export const SAMPLE_TXT = `第1集 雨夜契约
# 内景 · 伦敦 · 金融城写字楼 · 夜
暴雨。Lily 抱着被退回的设计稿站在电梯口。
Lily：再给我一次机会，我能证明那份方案是我做的。
Henry：（摘下眼镜）证明给我看。明早九点，我的办公室。
【卡点】电梯门合上的瞬间，Lily 看见抄袭者正挽着 Henry 的未婚妻走过。

第2集 第一次交锋
# 内景 · Henry 办公室 · 日
Lily 把原稿摊在桌上，每一页都写着日期。
Henry：有意思。你想要什么？
Lily：我要她当众道歉，以及——这个项目的署名。
【卡点】Henry 按下内线：“通知董事会，下午的发布会换人。”

第3集 发布会
# 内景 · 发布会现场 · 日
闪光灯此起彼伏，抄袭者脸色煞白。
【卡点】大屏幕亮起，播放的是一段没人见过的监控录像。
`

const img = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=80`

const ts = (dayOffset: number, hour = 10) => {
  const d = new Date(Date.now() + dayOffset * 864e5)
  d.setHours(hour, (dayOffset * 37 + hour * 11) % 60, 0, 0)
  return d.toISOString()
}

function mk(
  s: Omit<Script, 'priceHistory' | 'createdAt' | 'trialCount' | 'extra'> & { createdOffset: number; trialCount?: number },
): Script {
  const { createdOffset, ...rest } = s
  const createdAt = ts(createdOffset)
  return {
    trialCount: s.episodes.length,
    extra: {},
    ...rest,
    // 真实业务数据从零开始：预置销量、文件名、编造的调价历史一律不带入
    sales: 0,
    fileName: undefined,
    fileSize: undefined,
    createdAt,
    priceHistory: [{ price: s.price, at: createdAt, note: '初始定价' }],
  }
}

export function seedScripts(): Script[] {
  return [
    mk({
      id: 's1',
      quality: 'S 顶级精品',
      saleType: 'wholesale',
      title: '总裁的契约新娘',
      enTitle: "The CEO's Contract Bride",
      logline: '一纸契约，五百万美金，她成了纽约最冷酷总裁的一年期妻子。',
      synopsis:
        '为救病重的母亲，落魄设计师 Emma 闯进 Sterling 集团顶层求助，却被总裁 Adrian 提出一份荒唐契约——做他一年的妻子。豪门试探、前任纠缠、继妹陷害接踵而至，而 Adrian 娶她的真正原因，藏在十年前的一场大火里。',
      cover: img('1715619044226-b693312ffb9b'),
      tags: ['契约婚姻', '先婚后爱', '打脸', '豪门'],
      markets: ['北美', '欧洲'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 80,
      price: 2800,
      status: 'on',
      sales: 46,
      rating: 4.9,
      createdOffset: -60,
      fileName: 'CEO_Contract_Bride_EP1-80.docx',
      fileSize: 1_840_000,
      episodes: [
        {
          title: '五百万的契约',
          text: `# 内景 · 纽约曼哈顿 · Sterling 集团顶层 · 夜
暴雨拍打着落地窗。Emma 浑身湿透，攥着一张医院缴费单站在门口。
Adrian：（头也不抬）你只有三分钟。
Emma：我需要五十万美元，救我母亲。
Adrian：（合上文件，抬眼）我可以给你五百万。条件是——做我一年的妻子。
Emma 愣住，缴费单从指间滑落。
【卡点】Adrian 把一份早已打印好的婚前协议推到她面前，签名处写着她的名字。`,
        },
        {
          title: '前任与继妹',
          text: `# 外景 · Sterling 集团楼下 · 夜
前男友 Kyle 搂着继妹 Chloe 从跑车上下来，看见狼狈的 Emma，嗤笑出声。
Chloe：姐姐，这么晚还来求职？保安会把你赶出去的。
Kyle：Emma，回来求我，我还能给你留个助理的位置。
Emma 攥紧协议，一言不发。
【卡点】一辆劳斯莱斯停在面前，Adrian 撑伞走下：“上车，Mrs. Sterling。”`,
        },
        {
          title: '豪门家宴',
          text: `# 内景 · Sterling 庄园 · 餐厅 · 夜
长桌两侧坐满了 Sterling 家族成员，所有目光都落在 Emma 身上。
Grandma Sterling：一个连晚礼服都穿不稳的女孩？Adrian，你在开玩笑。
Adrian：（为 Emma 拉开椅子）奶奶，她是我唯一的妻子人选。
Emma 低头，发现餐盘下压着一张纸条：“离开他，否则你母亲活不过下周。”
【卡点】Emma 抬头，正对上表姐 Vivian 意味深长的微笑。`,
        },
      ],
    }),
    mk({
      id: 's2',
      quality: 'A 优质',
      saleType: 'wholesale',
      title: '狼王的弃选伴侣',
      enTitle: "The Alpha's Rejected Mate",
      logline: '被狼王当众拒绝的她，觉醒了整个族群最古老的血脉。',
      synopsis:
        '18 岁成年礼上，Luna 被命定伴侣——银月狼族新任狼王 Kai 当众拒绝。被放逐到边境的她意外唤醒沉睡的白狼之血，三年后以敌对族群首领的身份归来。当 Kai 跪求她回头时，她只说了一句：太迟了。',
      cover: img('1685955192099-bc7a058ec777'),
      tags: ['命定伴侣', '血脉觉醒', '追妻火葬场'],
      markets: ['北美', '欧洲', '拉美'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 90,
      price: 3200,
      status: 'on',
      sales: 38,
      rating: 4.8,
      createdOffset: -45,
      fileName: 'Alphas_Rejected_Mate.docx',
      fileSize: 2_310_000,
      episodes: [
        {
          title: '成年礼',
          text: `# 外景 · 银月森林 · 祭坛 · 满月之夜
狼群围成圆圈，月光洒在祭坛上。Luna 紧张地攥着裙角。
Elder：月神指引，命定伴侣将在今夜相认。
Kai 走近，嗅到她的气息，脸色骤变。
Kai：我，Kai·Silvermoon，拒绝你成为我的伴侣。
人群哗然。Luna 的胸口传来撕裂般的剧痛。
【卡点】她的瞳孔在剧痛中一瞬间变成了纯白色——没人注意到。`,
        },
        {
          title: '放逐',
          text: `# 外景 · 族群边境 · 雨夜
Luna 被两名战士押到边境线外，行李被扔进泥里。
Warrior：狼王的命令，永远别回来。
Luna：（跪在雨里）我会回来的。但不是以你们想象的方式。
森林深处传来一声狼嚎，比任何狼王都更古老。
【卡点】一只通体雪白的巨狼从黑暗中走出，向她低下了头。`,
        },
        {
          title: '三年后',
          text: `# 内景 · 银月族议事厅 · 日
字幕：三年后。
侦察兵冲进议事厅。
Scout：Alpha！北境白狼族的首领来了，她要求……和您谈判。
大门推开，Luna 一身白色斗篷走进来，身后跟着整支白狼军队。
【卡点】Kai 手中的酒杯碎裂：“……Luna？”`,
        },
      ],
    }),
    mk({
      id: 's3',
      quality: 'S 顶级精品',
      saleType: 'wholesale',
      title: '重生之千金归来',
      enTitle: 'Return of the Heiress',
      logline: '被丈夫和闺蜜联手害死，她重生回到订婚宴前夜。',
      synopsis:
        '洛杉矶船王之女 Sophia 前世被丈夫与闺蜜联手夺走家产、推下游艇。一睁眼，她回到了五年前订婚宴的前夜。这一世，她要亲手撕下两人的面具，夺回属于自己的一切。',
      cover: img('1706153068774-5271417921a4'),
      tags: ['重生', '大女主', '爽文', '豪门'],
      markets: ['北美', '东南亚'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 70,
      price: 2600,
      status: 'on',
      sales: 52,
      rating: 4.9,
      createdOffset: -38,
      fileName: 'Return_of_the_Heiress.docx',
      fileSize: 1_520_000,
      episodes: [
        {
          title: '坠海',
          text: `# 外景 · 太平洋 · 游艇甲板 · 夜
Sophia 被推到栏杆边，丈夫 Ethan 搂着她最好的闺蜜 Madison。
Madison：你的一切，现在都是我们的了。
Sophia：Ethan……五年的婚姻，你一直在骗我？
Ethan：（冷笑）从订婚那天起。
【卡点】冰冷的海水灌进肺里，Sophia 猛地睁开眼——床头的日历停在五年前。`,
        },
        {
          title: '订婚宴前夜',
          text: `# 内景 · Sophia 卧室 · 夜
Sophia 盯着镜子里年轻五岁的自己，手机亮起：“亲爱的，明天见。——Ethan”
Sophia：（删掉消息）明天，我会让你记一辈子。
她翻出父亲的私人律师名片，拨通电话。
Sophia：Mr. Grant，我要修改信托受益人。立刻。`,
        },
        {
          title: '当众退婚',
          text: `# 内景 · 比弗利山庄酒店 · 宴会厅 · 夜
水晶灯下，Ethan 单膝跪地，Madison 在人群中鼓掌。
Sophia 接过话筒，按下遥控器。
大屏幕上播放出 Ethan 与 Madison 在车里亲吻的视频。
【卡点】Sophia：“这枚戒指，你还是留给她吧。”`,
        },
      ],
    }),
    mk({
      id: 's4',
      quality: 'A 优质',
      saleType: 'buyout',
      title: '王座之下',
      enTitle: 'Beneath the Throne',
      logline: '现代历史系学生穿越成亡国公主，用知识夺回王座。',
      synopsis:
        '历史系研究生 Aria 在博物馆触碰一顶古王冠后，穿越成被篡位叔父囚禁的阿斯兰王国公主。她用现代知识化解瘟疫、改良军械，与神秘骑士团长 Lucien 结盟，一步步走向那张染血的王座。',
      cover: img('1485465053475-dd55ed3894b9'),
      tags: ['宫廷权谋', '女帝', '史诗'],
      markets: ['欧洲', '北美', '日韩'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 100,
      price: 9800,
      status: 'on',
      sales: 0,
      rating: 4.7,
      createdOffset: -30,
      fileName: 'Beneath_the_Throne_S1.docx',
      fileSize: 3_050_000,
      episodes: [
        {
          title: '王冠',
          text: `# 内景 · 大英博物馆 · 闭馆后 · 夜
Aria 独自整理展品，玻璃柜里的王冠忽然发出微光。
Aria：（伸手）这不可能……展柜明明是锁着的。
指尖触到王冠的瞬间，整个展厅陷入黑暗。
【卡点】再睁眼，她身处阴冷的石牢，一个声音在门外说：“公主殿下，明天就是您的处刑日。”`,
        },
        {
          title: '处刑台',
          text: `# 外景 · 阿斯兰王城 · 广场 · 日
人群聚集，篡位者 Duke Morven 站在高台上。
Morven：前王之女，以叛国罪处死。
Aria：（高声）陛下，处死我之前，您不想知道城中瘟疫的解法吗？
广场瞬间安静。
【卡点】人群中，一名黑甲骑士缓缓拔出了剑。`,
        },
      ],
    }),
    mk({
      id: 's5',
      quality: 'B 良好',
      saleType: 'wholesale',
      title: '午夜证人',
      enTitle: 'Midnight Witness',
      logline: '她是凶案唯一的目击者，而凶手就坐在警局对面。',
      synopsis:
        '夜班护士 Nora 下班途中目睹一场谋杀，却发现负责此案的明星警探 Ryan 与凶手长着同一张脸。一边是越来越近的威胁，一边是无人相信的证词，Nora 只能自己找出真相。',
      cover: img('1520267819959-5fe7025b9aa8'),
      tags: ['双胞胎', '反转', '高智商'],
      markets: ['北美', '欧洲', '日韩'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 60,
      price: 2200,
      status: 'on',
      sales: 27,
      rating: 4.6,
      createdOffset: -20,
      fileName: 'Midnight_Witness.docx',
      fileSize: 640_000,
      episodes: [
        {
          title: '凌晨两点',
          text: `# 外景 · 芝加哥 · 小巷 · 凌晨
Nora 拎着咖啡走出医院，巷子深处传来一声闷响。
她躲在垃圾箱后，看见一个男人把什么东西拖进车里。
路灯照亮了男人的侧脸。
【卡点】Nora 的手机突然响起，男人猛地转头看向她的方向。`,
        },
        {
          title: '同一张脸',
          text: `# 内景 · 芝加哥警局 · 日
Nora 坐在审讯室，门被推开。
Ryan：我是负责本案的 Ryan 警探。别怕，慢慢说。
Nora 抬头，手中的纸杯被捏扁——眼前的人，就是昨晚那个男人。
【卡点】Ryan 微笑着关上门：“你刚刚，好像想起了什么？”`,
        },
      ],
    }),
    mk({
      id: 's6',
      quality: 'A 优质',
      saleType: 'wholesale',
      title: '隐藏的亿万继承人',
      enTitle: 'The Hidden Billionaire',
      logline: '被岳父一家当成废物的上门女婿，其实是全球首富的唯一继承人。',
      synopsis:
        '入赘三年的 Jack 受尽岳父一家冷眼。在妻子被逼离婚的那天，一架私人飞机降落在家门口——全球首富 Ashford 家族找了他整整二十年。是继续隐藏，还是让所有人付出代价？',
      cover: img('1583263496887-4e3046c78090'),
      tags: ['隐藏身份', '逆袭', '打脸', '男频爆款'],
      markets: ['北美', '中东', '东南亚'],
      audience: '男频',
      language: '英语',
      totalEpisodes: 85,
      price: 3000,
      status: 'on',
      sales: 64,
      rating: 4.8,
      createdOffset: -14,
      fileName: 'Hidden_Billionaire_Full.docx',
      fileSize: 2_010_000,
      episodes: [
        {
          title: '离婚协议',
          text: `# 内景 · Miller 家客厅 · 日
岳母把离婚协议摔在 Jack 面前。
Mrs. Miller：签了它，拿着这一千美元滚出去。
Jack：（看向妻子 Olivia）这也是你的意思吗？
Olivia 红着眼摇头，却被父亲一把拽开。
【卡点】窗外传来巨大的轰鸣，一架印着金色家徽的直升机降落在草坪上。`,
        },
        {
          title: '少爷，请回家',
          text: `# 外景 · Miller 家草坪 · 日
十二名黑衣保镖列队，白发管家走到 Jack 面前深深鞠躬。
Butler：少爷，Ashford 家族找了您二十年。老爷说，是时候回家了。
Mr. Miller：（腿一软）Ashford？那个 Ashford？
【卡点】Jack 回头看向岳父：“刚才那一千美元，你说给谁？”`,
        },
      ],
    }),
    mk({
      id: 's7',
      quality: 'B 良好',
      saleType: 'buyout',
      title: '逆袭女王',
      enTitle: 'Queen of Comeback',
      logline: '被雪藏的天后，用一档选秀节目向整个娱乐圈宣战。',
      synopsis:
        '十年前红极一时的天后 Vera 因丑闻被雪藏。当年设计她的经纪人如今已是传媒帝国的掌舵人。Vera 以导师身份重回选秀舞台，每一期节目，都是一次精准的复仇。',
      cover: img('1572466040501-4d2415fcbb88'),
      tags: ['娱乐圈', '大女主', '反击'],
      markets: ['北美', '拉美', '东南亚'],
      audience: '女频',
      language: '西班牙语',
      totalEpisodes: 72,
      price: 7600,
      status: 'on',
      sales: 0,
      rating: 4.7,
      createdOffset: -7,
      fileName: 'Queen_of_Comeback.docx',
      fileSize: 1_390_000,
      episodes: [
        {
          title: '重返舞台',
          text: `# 内景 · 选秀节目录制现场 · 夜
主持人：今晚的神秘导师是——
灯光亮起，Vera 从升降台缓缓升起，全场死寂。
后台，传媒大亨 Marcus 手中的平板摔在地上。
Vera：（对着镜头）好久不见，Marcus。
【卡点】大屏幕上打出一行字：“第一期淘汰名单，由我决定。”`,
        },
        {
          title: '第一份名单',
          text: `# 内景 · 导演休息室 · 夜
Marcus：你以为一个过气歌手能翻起什么浪？
Vera：（把一个 U 盘放在桌上）十年前那晚的录音，你想让谁先听？
【卡点】门外，偷听的女学员悄悄按下了录音键。`,
        },
      ],
    }),
    mk({
      id: 's8',
      quality: 'B 良好',
      saleType: 'wholesale',
      title: '雾堡来信',
      enTitle: 'Letters from Misthaven',
      logline: '每晚午夜，她都会收到一封来自百年前的信。',
      synopsis:
        '继承了苏格兰古堡的插画师 Clara，每晚午夜都会在书房收到一封署名 1897 年的信。写信人预言了她身边将发生的每一场死亡，而最后一封信上，写着她自己的名字。',
      cover: img('1514539079130-25950c84af65'),
      tags: ['古堡', '时空书信', '哥特'],
      markets: ['欧洲', '日韩'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 60,
      price: 2400,
      status: 'off',
      sales: 9,
      rating: 4.5,
      createdOffset: -90,
      fileName: 'Misthaven_Letters.docx',
      fileSize: 980_000,
      episodes: [
        {
          title: '第一封信',
          text: `# 内景 · 雾堡书房 · 午夜
钟声敲响十二下，书桌上凭空多了一封泛黄的信。
Clara：（念）“亲爱的 Clara，明天，管家会从塔楼上坠落。——E.”
【卡点】第二天清晨，塔楼下传来尖叫。`,
        },
      ],
    }),
    mk({
      id: 's9',
      quality: '',
      saleType: 'wholesale',
      title: '落难公主与她的骑士',
      enTitle: 'The Fallen Princess',
      logline: '穿越成炮灰公主，她决定先把反派骑士变成自己人。',
      synopsis: '社畜 Mia 穿进自己最爱的小说，成了第 3 章就被处死的炮灰公主。为了活命，她决定攻略那个将来会血洗王宫的反派骑士。',
      cover: img('1598261366156-179e7d88d2e9'),
      tags: ['穿书', '反派攻略', '轻喜剧'],
      markets: ['东南亚', '日韩'],
      audience: '女频',
      language: '英语',
      totalEpisodes: 75,
      price: 2500,
      status: 'draft',
      sales: 0,
      rating: 0,
      createdOffset: -2,
      episodes: [
        {
          title: '炮灰公主',
          text: `# 内景 · 王宫寝殿 · 晨
Mia 从天鹅绒大床上惊醒，侍女跪在床边。
Maid：公主殿下，骑士团长 Damien 求见。
Mia：（内心）Damien？那个第 3 章就砍了我脑袋的 Damien？！`,
        },
      ],
    }),
  ]
}

