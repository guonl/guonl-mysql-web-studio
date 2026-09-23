/* 演示数据：内置示例「服务器」，含 3 个 schema、11 张表 + 2 个视图
   全部字段带中文注释（用于展示「表头字段 + 描述」能力） */

export interface DemoColumn {
  name: string
  type: string
  nullable?: boolean
  key?: 'PRI' | 'UNI' | 'MUL' | ''
  def?: string | null
  extra?: string
  comment?: string
}

export interface DemoIndex {
  name: string
  cols: string[]
  unique?: boolean
}

export interface DemoTableDef {
  name: string
  type?: 'TABLE' | 'VIEW'
  engine?: string
  comment?: string
  columns: DemoColumn[]
  pk: string[]
  indexes?: DemoIndex[]
  viewFrom?: string // 视图来源表
  viewSelect?: (rows: Record<string, unknown>[]) => Record<string, unknown>[]
  gen?: (rnd: () => number, count: number) => Record<string, unknown>[]
  count?: number
}

export interface DemoSchemaDef {
  name: string
  comment: string
  tables: DemoTableDef[]
}

/* ---------- 确定性随机（保证演示数据稳定） ---------- */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(rnd: () => number, arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
const int = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1))

/* ---------- 数据字典 ---------- */
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '苏州', '长沙']
const FAMILY = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '林']
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '文轩', '雨欣', '梓涵', '子轩', '浩然']
const PRODUCT_WORDS = ['智能', '无线', '便携', '经典', '旗舰', '青春', '轻盈', '碳纤维', '钛合金', '无线充电']
const PRODUCT_TYPES = ['蓝牙耳机', '机械键盘', '电动牙刷', '移动电源', '显示器', '人体工学椅', '智能手表', '路由器', '摄像头', '音箱', '鼠标', '笔记本支架', '台灯', '加湿器', '咖啡机']
const ARTICLE_WORDS = ['深入理解', '浅析', '实践', '从零开始', '避坑指南', '性能调优', '最佳实践', '原理剖析', '源码解读', '入门到精通']
const ARTICLE_TOPICS = ['MySQL 索引', 'React 状态管理', '微服务治理', '前端工程化', 'Kubernetes 网络', 'TypeScript 类型体操', 'Redis 缓存', '分布式事务', 'CSS 布局', '浏览器渲染']
const ORDER_STATUSES = [
  { v: 0, w: 8, n: '待支付' }, { v: 1, w: 22, n: '已支付' }, { v: 2, w: 45, n: '已发货' },
  { v: 3, w: 20, n: '已完成' }, { v: 4, w: 4, n: '已取消' }, { v: 5, w: 1, n: '售后中' },
]
function weightedPick<T extends { w: number }>(rnd: () => number, arr: T[]): T {
  const total = arr.reduce((s, x) => s + x.w, 0)
  let r = rnd() * total
  for (const x of arr) { r -= x.w; if (r <= 0) return x }
  return arr[arr.length - 1]
}
const dateStr = (rnd: () => number, startDaysAgo: number, endDaysAgo: number) => {
  const days = startDaysAgo - rnd() * (startDaysAgo - endDaysAgo)
  const t = Date.now() - days * 86400_000
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(int(rnd, 0, 23))}:${p(int(rnd, 0, 59))}:${p(int(rnd, 0, 59))}`
}
const dayStr = (rnd: () => number, maxDaysAgo: number, offset = 0) => {
  const d = new Date(Date.now() - (maxDaysAgo - offset) * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------- shop 库 ---------- */
const shopUsers: DemoTableDef = {
  name: 'users',
  engine: 'InnoDB',
  comment: '用户表',
  pk: ['id'],
  indexes: [
    { name: 'uk_username', cols: ['username'], unique: true },
    { name: 'idx_phone', cols: ['phone'] },
    { name: 'idx_city_status', cols: ['city', 'status'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '用户ID' },
    { name: 'username', type: 'varchar(50)', nullable: false, key: 'UNI', comment: '用户名（登录名，唯一）' },
    { name: 'nickname', type: 'varchar(50)', nullable: false, comment: '昵称' },
    { name: 'email', type: 'varchar(100)', nullable: true, comment: '邮箱' },
    { name: 'phone', type: 'varchar(20)', nullable: true, key: 'MUL', comment: '手机号' },
    { name: 'gender', type: "enum('M','F','U')", nullable: false, def: 'U', comment: '性别：M男 F女 U未知' },
    { name: 'city', type: 'varchar(30)', nullable: false, key: 'MUL', comment: '所在城市' },
    { name: 'balance', type: 'decimal(10,2)', nullable: false, def: '0.00', comment: '账户余额（元）' },
    { name: 'status', type: 'tinyint', nullable: false, def: '1', comment: '状态：0禁用 1正常 2冻结' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '注册时间' },
    { name: 'updated_at', type: 'datetime', nullable: true, comment: '最后更新时间' },
  ],
  count: 60,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const name = pick(rnd, FAMILY) + pick(rnd, GIVEN)
    const g = pick(rnd, ['M', 'F', 'U']) as string
    return {
      id: i + 1,
      username: `user_${String(1000 + i)}`,
      nickname: name,
      email: `user${1000 + i}@${pick(rnd, ['qq.com', '163.com', 'gmail.com'])}`,
      phone: rnd() < 0.85 ? `13${int(rnd, 0, 9)}${String(int(rnd, 10000000, 99999999))}` : null,
      gender: g,
      city: pick(rnd, CITIES),
      balance: (rnd() * 5000).toFixed(2),
      status: rnd() < 0.9 ? 1 : pick(rnd, [0, 2]),
      created_at: dateStr(rnd, 730, 30),
      updated_at: rnd() < 0.4 ? dateStr(rnd, 30, 0) : null,
    }
  }),
}

const shopCategories: DemoTableDef = {
  name: 'categories',
  engine: 'InnoDB',
  comment: '商品分类（支持两级树形结构）',
  pk: ['id'],
  indexes: [{ name: 'idx_parent', cols: ['parent_id'] }],
  columns: [
    { name: 'id', type: 'int unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '分类ID' },
    { name: 'name', type: 'varchar(50)', nullable: false, comment: '分类名称' },
    { name: 'parent_id', type: 'int unsigned', nullable: true, key: 'MUL', def: null, comment: '父分类ID，NULL 表示一级分类' },
    { name: 'sort', type: 'int', nullable: false, def: '0', comment: '排序权重，越小越靠前' },
    { name: 'is_leaf', type: 'tinyint(1)', nullable: false, def: '0', comment: '是否叶子节点：1是 0否' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '创建时间' },
  ],
  count: 16,
  gen: (rnd, n) => {
    const tops = ['数码家电', '服饰鞋包', '美妆个护', '食品生鲜', '家居日用']
    const subs: Record<string, string[]> = {
      数码家电: ['手机通讯', '电脑办公', '影音设备'],
      服饰鞋包: ['男装', '女装', '箱包'],
      美妆个护: ['护肤', '洗护'],
      食品生鲜: ['休闲零食', '茶叶咖啡'],
      家居日用: ['清洁用品', '厨房用具'],
    }
    const rows: Record<string, unknown>[] = []
    let id = 1
    tops.forEach((t, ti) => {
      rows.push({ id: id++, name: t, parent_id: null, sort: ti, is_leaf: 0, created_at: dateStr(rnd, 900, 800) })
      subs[t].forEach((s, si) => {
        rows.push({ id: id++, name: s, parent_id: id - 1 - si - 1, sort: si, is_leaf: 1, created_at: dateStr(rnd, 900, 700) })
      })
    })
    return rows.slice(0, n)
  },
}

const shopProducts: DemoTableDef = {
  name: 'products',
  engine: 'InnoDB',
  comment: '商品表',
  pk: ['id'],
  indexes: [
    { name: 'idx_category', cols: ['category_id'] },
    { name: 'idx_status_sales', cols: ['status', 'sales'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '商品ID（SPU）' },
    { name: 'category_id', type: 'int unsigned', nullable: false, key: 'MUL', comment: '所属分类ID → categories.id' },
    { name: 'name', type: 'varchar(200)', nullable: false, comment: '商品名称' },
    { name: 'price', type: 'decimal(10,2)', nullable: false, comment: '售价（元）' },
    { name: 'cost', type: 'decimal(10,2)', nullable: true, comment: '成本价（元），仅内部可见' },
    { name: 'stock', type: 'int', nullable: false, def: '0', comment: '库存数量' },
    { name: 'sales', type: 'int unsigned', nullable: false, def: '0', comment: '累计销量' },
    { name: 'status', type: 'tinyint', nullable: false, def: '1', comment: '状态：0下架 1在售 2预售' },
    { name: 'tags', type: 'varchar(200)', nullable: true, comment: '标签，逗号分隔' },
    { name: 'description', type: 'text', nullable: true, comment: '商品详情描述' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '上架时间' },
    { name: 'updated_at', type: 'datetime', nullable: true, comment: '最后修改时间' },
  ],
  count: 80,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const price = Number((rnd() * 1900 + 39).toFixed(2))
    const name = `${pick(rnd, PRODUCT_WORDS)}${pick(rnd, PRODUCT_TYPES)} ${pick(rnd, ['Pro', 'Air', 'Max', 'SE', 'Plus', '2025款'])}`
    return {
      id: i + 1,
      category_id: int(rnd, 6, 16),
      name,
      price,
      cost: Number((price * (0.45 + rnd() * 0.25)).toFixed(2)),
      stock: int(rnd, 0, 900),
      sales: int(rnd, 0, 12000),
      status: rnd() < 0.85 ? 1 : pick(rnd, [0, 2]),
      tags: rnd() < 0.6 ? `${pick(rnd, ['热卖', '新品', '自营', '包邮'])},${pick(rnd, ['正品', '限时折扣', '赠品'])}` : null,
      description: rnd() < 0.8 ? `${name}。精选材质，做工精致，${pick(rnd, ['一年质保', '三十天无理由退换', '全国联保'])}。` : null,
      created_at: dateStr(rnd, 600, 7),
      updated_at: rnd() < 0.5 ? dateStr(rnd, 7, 0) : null,
    }
  }),
}

const shopOrders: DemoTableDef = {
  name: 'orders',
  engine: 'InnoDB',
  comment: '订单主表',
  pk: ['id'],
  indexes: [
    { name: 'uk_order_no', cols: ['order_no'], unique: true },
    { name: 'idx_user', cols: ['user_id'] },
    { name: 'idx_status_created', cols: ['status', 'created_at'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '订单ID' },
    { name: 'order_no', type: 'varchar(32)', nullable: false, key: 'UNI', comment: '业务订单号（唯一）' },
    { name: 'user_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '下单用户ID → users.id' },
    { name: 'amount', type: 'decimal(12,2)', nullable: false, comment: '订单总金额（元）' },
    { name: 'discount', type: 'decimal(12,2)', nullable: false, def: '0.00', comment: '优惠金额（元）' },
    { name: 'status', type: 'tinyint', nullable: false, def: '0', comment: '状态：0待支付 1已支付 2已发货 3已完成 4已取消 5售后中' },
    { name: 'pay_type', type: "enum('alipay','wechat','card')", nullable: true, comment: '支付方式：支付宝/微信/银行卡' },
    { name: 'receiver', type: 'varchar(50)', nullable: true, comment: '收货人姓名' },
    { name: 'address', type: 'varchar(255)', nullable: true, comment: '收货地址' },
    { name: 'remark', type: 'varchar(500)', nullable: true, comment: '买家备注' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '下单时间' },
    { name: 'paid_at', type: 'datetime', nullable: true, comment: '支付时间' },
  ],
  count: 130,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const st = weightedPick(rnd, ORDER_STATUSES).v as number
    const created = dateStr(rnd, 180, 0)
    return {
      id: i + 1,
      order_no: `SO${Date.now() - (n - i) * 1000}${String(i).padStart(4, '0')}`.slice(0, 24),
      user_id: int(rnd, 1, 60),
      amount: Number((rnd() * 4000 + 50).toFixed(2)),
      discount: rnd() < 0.4 ? Number((rnd() * 100).toFixed(2)) : 0,
      status: st,
      pay_type: st >= 1 && st <= 3 ? pick(rnd, ['alipay', 'wechat', 'card']) : null,
      receiver: rnd() < 0.92 ? pick(rnd, FAMILY) + pick(rnd, GIVEN) : null,
      address: rnd() < 0.92 ? `${pick(rnd, CITIES)}市${pick(rnd, ['高新区', '朝阳区', '浦东新区', '天河区', '南山区'])}${pick(rnd, ['科技园', '中心广场', '创业大厦', '幸福小区'])}${int(rnd, 1, 30)}号` : null,
      remark: rnd() < 0.25 ? pick(rnd, ['尽快发货', '请勿放驿站', '工作日送货', '包装严实一些']) : null,
      created_at: created,
      paid_at: st >= 1 && st <= 3 ? dateStr(rnd, 180, 0) : null,
    }
  }),
}

const shopOrderItems: DemoTableDef = {
  name: 'order_items',
  engine: 'InnoDB',
  comment: '订单明细表',
  pk: ['id'],
  indexes: [
    { name: 'idx_order', cols: ['order_id'] },
    { name: 'idx_product', cols: ['product_id'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '明细ID' },
    { name: 'order_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '订单ID → orders.id' },
    { name: 'product_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '商品ID → products.id' },
    { name: 'product_name', type: 'varchar(200)', nullable: false, comment: '商品名称快照（下单时的名称）' },
    { name: 'price', type: 'decimal(10,2)', nullable: false, comment: '成交单价（元）' },
    { name: 'quantity', type: 'int', nullable: false, def: '1', comment: '购买数量' },
  ],
  count: 280,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    order_id: int(rnd, 1, 130),
    product_id: int(rnd, 1, 80),
    product_name: `${pick(rnd, PRODUCT_WORDS)}${pick(rnd, PRODUCT_TYPES)} ${pick(rnd, ['Pro', 'Air', 'SE', '2025款'])}`,
    price: Number((rnd() * 1500 + 29).toFixed(2)),
    quantity: int(rnd, 1, 4),
  })),
}

const shopPayments: DemoTableDef = {
  name: 'payments',
  engine: 'InnoDB',
  comment: '支付流水表',
  pk: ['id'],
  indexes: [
    { name: 'idx_order', cols: ['order_id'] },
    { name: 'uk_pay_no', cols: ['pay_no'], unique: true },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '流水ID' },
    { name: 'pay_no', type: 'varchar(40)', nullable: false, key: 'UNI', comment: '第三方支付流水号（唯一）' },
    { name: 'order_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '订单ID → orders.id' },
    { name: 'channel', type: "enum('alipay','wechat','card')", nullable: false, comment: '支付渠道' },
    { name: 'amount', type: 'decimal(12,2)', nullable: false, comment: '支付金额（元）' },
    { name: 'status', type: 'tinyint', nullable: false, def: '0', comment: '状态：0处理中 1成功 2失败 3已退款' },
    { name: 'paid_at', type: 'datetime', nullable: true, comment: '支付完成时间' },
    { name: 'callback_at', type: 'datetime', nullable: true, comment: '回调到达时间' },
  ],
  count: 110,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const st = pick(rnd, [1, 1, 1, 0, 2, 3]) as number
    return {
      id: i + 1,
      pay_no: `PAY${int(rnd, 100000000, 999999999)}${String(i).padStart(3, '0')}`,
      order_id: int(rnd, 1, 130),
      channel: pick(rnd, ['alipay', 'wechat', 'card']),
      amount: Number((rnd() * 3500 + 50).toFixed(2)),
      status: st,
      paid_at: st === 1 || st === 3 ? dateStr(rnd, 180, 0) : null,
      callback_at: st === 1 || st === 3 ? dateStr(rnd, 180, 0) : null,
    }
  }),
}

/* shop 视图：订单详情宽表 */
const shopVOrderDetail: DemoTableDef = {
  name: 'v_order_detail',
  type: 'VIEW',
  comment: '视图：订单详情宽表（关联用户与商品）',
  pk: [],
  viewFrom: 'orders',
  columns: [
    { name: 'order_id', type: 'bigint unsigned', nullable: false, comment: '订单ID' },
    { name: 'order_no', type: 'varchar(32)', nullable: false, comment: '订单号' },
    { name: 'status', type: 'tinyint', nullable: false, comment: '订单状态' },
    { name: 'amount', type: 'decimal(12,2)', nullable: false, comment: '订单金额' },
    { name: 'username', type: 'varchar(50)', nullable: false, comment: '下单用户名' },
    { name: 'user_city', type: 'varchar(30)', nullable: false, comment: '用户城市' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '下单时间' },
  ],
  viewSelect: (orders) => {
    const users = new Map<string, Record<string, unknown>>()
    const userRows = DEMO_SCHEMAS.find((s) => s.name === 'shop')!.tables.find((t) => t.name === 'users')!.gen!(mulberry32(42), 60)
    userRows.forEach((u) => users.set(String(u.id), u))
    return orders.map((o) => {
      const u = users.get(String(o.user_id)) ?? {}
      return {
        order_id: o.id, order_no: o.order_no, status: o.status, amount: o.amount,
        username: u.username, user_city: u.city, created_at: o.created_at,
      }
    })
  },
}

/* ---------- blog 库 ---------- */
const blogArticles: DemoTableDef = {
  name: 'articles',
  engine: 'InnoDB',
  comment: '文章表',
  pk: ['id'],
  indexes: [
    { name: 'idx_author', cols: ['author_id'] },
    { name: 'idx_status_pub', cols: ['status', 'published_at'] },
    { name: 'ft_title', cols: ['title'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '文章ID' },
    { name: 'title', type: 'varchar(200)', nullable: false, comment: '文章标题' },
    { name: 'summary', type: 'varchar(500)', nullable: true, comment: '摘要（列表页展示）' },
    { name: 'content', type: 'mediumtext', nullable: true, comment: '正文（Markdown）' },
    { name: 'author_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '作者ID → users.id（跨库逻辑关联）' },
    { name: 'category', type: 'varchar(50)', nullable: false, comment: '文章分类' },
    { name: 'views', type: 'int unsigned', nullable: false, def: '0', comment: '浏览量' },
    { name: 'likes', type: 'int unsigned', nullable: false, def: '0', comment: '点赞数' },
    { name: 'status', type: 'tinyint', nullable: false, def: '0', comment: '状态：0草稿 1已发布 2下架' },
    { name: 'published_at', type: 'datetime', nullable: true, comment: '发布时间' },
  ],
  count: 42,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const title = `${pick(rnd, ARTICLE_WORDS)}${pick(rnd, ARTICLE_TOPICS)}`
    const st = rnd() < 0.8 ? 1 : pick(rnd, [0, 2]) as number
    return {
      id: i + 1,
      title,
      summary: `${title}——本文结合真实项目经验，系统梳理了关键要点与常见误区。`,
      content: rnd() < 0.7 ? `# ${title}\n\n## 背景\n\n在实际项目中……\n\n## 核心思路\n\n1. 第一步\n2. 第二步\n\n## 小结\n\n希望对你有帮助。` : null,
      author_id: int(rnd, 1, 60),
      category: pick(rnd, ['后端', '前端', '架构', '数据库', '运维', 'AI']),
      views: int(rnd, 0, 98000),
      likes: int(rnd, 0, 4200),
      status: st,
      published_at: st === 1 ? dateStr(rnd, 500, 1) : null,
    }
  }),
}

const blogComments: DemoTableDef = {
  name: 'comments',
  engine: 'InnoDB',
  comment: '文章评论表',
  pk: ['id'],
  indexes: [
    { name: 'idx_article', cols: ['article_id'] },
    { name: 'idx_user', cols: ['user_id'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '评论ID' },
    { name: 'article_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '文章ID → articles.id' },
    { name: 'user_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '评论人ID → users.id' },
    { name: 'content', type: 'varchar(1000)', nullable: false, comment: '评论内容' },
    { name: 'reply_to', type: 'bigint unsigned', nullable: true, def: null, comment: '回复的评论ID，NULL 表示直接评论' },
    { name: 'likes', type: 'int unsigned', nullable: false, def: '0', comment: '点赞数' },
    { name: 'status', type: 'tinyint', nullable: false, def: '1', comment: '状态：0隐藏 1展示' },
    { name: 'created_at', type: 'datetime', nullable: false, comment: '评论时间' },
  ],
  count: 150,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    article_id: int(rnd, 1, 42),
    user_id: int(rnd, 1, 60),
    content: pick(rnd, ['写得太好了，收藏！', '请问有配套源码吗？', '第二点深有体会，踩过同样的坑。', '总结很到位，感谢分享～', '学到了，期待续集。', '有疑问：生产环境这么用稳定吗？', 'mark 一下，周末细看。']),
    reply_to: rnd() < 0.3 ? int(rnd, 1, i || 1) : null,
    likes: int(rnd, 0, 300),
    status: rnd() < 0.95 ? 1 : 0,
    created_at: dateStr(rnd, 400, 0),
  })),
}

const blogTags: DemoTableDef = {
  name: 'tags',
  engine: 'InnoDB',
  comment: '标签表',
  pk: ['id'],
  indexes: [{ name: 'uk_name', cols: ['name'], unique: true }],
  columns: [
    { name: 'id', type: 'int unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '标签ID' },
    { name: 'name', type: 'varchar(50)', nullable: false, key: 'UNI', comment: '标签名（唯一）' },
    { name: 'hot', type: 'tinyint(1)', nullable: false, def: '0', comment: '是否热门标签' },
  ],
  count: 12,
  gen: (rnd, n) => ['MySQL', 'Redis', 'React', 'Vue', 'TypeScript', 'Docker', 'K8s', '分布式', '性能优化', '架构设计', 'AI', '前端工程化']
    .slice(0, n).map((name, i) => ({ id: i + 1, name, hot: rnd() < 0.4 ? 1 : 0 })),
}

const blogArticleTags: DemoTableDef = {
  name: 'article_tags',
  engine: 'InnoDB',
  comment: '文章-标签关联表（多对多）',
  pk: ['id'],
  indexes: [
    { name: 'uk_article_tag', cols: ['article_id', 'tag_id'], unique: true },
    { name: 'idx_tag', cols: ['tag_id'] },
  ],
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '关联ID' },
    { name: 'article_id', type: 'bigint unsigned', nullable: false, key: 'MUL', comment: '文章ID' },
    { name: 'tag_id', type: 'int unsigned', nullable: false, key: 'MUL', comment: '标签ID' },
  ],
  count: 90,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, article_id: int(rnd, 1, 42), tag_id: int(rnd, 1, 12) })),
}

/* blog 视图：热门文章 */
const blogVHot: DemoTableDef = {
  name: 'v_hot_articles',
  type: 'VIEW',
  comment: '视图：已发布且浏览量前 20 的文章',
  pk: [],
  viewFrom: 'articles',
  columns: [
    { name: 'id', type: 'bigint unsigned', nullable: false, comment: '文章ID' },
    { name: 'title', type: 'varchar(200)', nullable: false, comment: '标题' },
    { name: 'category', type: 'varchar(50)', nullable: false, comment: '分类' },
    { name: 'views', type: 'int unsigned', nullable: false, comment: '浏览量' },
    { name: 'likes', type: 'int unsigned', nullable: false, comment: '点赞数' },
    { name: 'published_at', type: 'datetime', nullable: true, comment: '发布时间' },
  ],
  viewSelect: (articles) =>
    (articles as Record<string, unknown>[])
      .filter((a) => a.status === 1)
      .sort((a, b) => (b.views as number) - (a.views as number))
      .slice(0, 20)
      .map((a) => ({ id: a.id, title: a.title, category: a.category, views: a.views, likes: a.likes, published_at: a.published_at })),
}

/* ---------- analytics 库 ---------- */
const analyticsDaily: DemoTableDef = {
  name: 'daily_sales',
  engine: 'InnoDB',
  comment: '每日销售汇总（离线 T+1 生成）',
  pk: ['id'],
  indexes: [{ name: 'uk_date', cols: ['stat_date'], unique: true }],
  columns: [
    { name: 'id', type: 'int unsigned', nullable: false, key: 'PRI', def: null, extra: 'auto_increment', comment: '记录ID' },
    { name: 'stat_date', type: 'date', nullable: false, key: 'UNI', comment: '统计日期' },
    { name: 'gmv', type: 'decimal(14,2)', nullable: false, comment: '当日成交总额（元）' },
    { name: 'orders_cnt', type: 'int unsigned', nullable: false, comment: '订单数' },
    { name: 'pay_users', type: 'int unsigned', nullable: false, comment: '支付买家数' },
    { name: 'uv', type: 'int unsigned', nullable: false, comment: '独立访客数' },
    { name: 'pv', type: 'int unsigned', nullable: false, comment: '页面访问量' },
  ],
  count: 90,
  gen: (rnd, n) => Array.from({ length: n }, (_, i) => {
    const weekend = new Date(Date.now() - (n - 1 - i) * 86400_000).getDay()
    const boost = weekend === 0 || weekend === 6 ? 1.35 : 1
    return {
      id: i + 1,
      stat_date: dayStr(rnd, n, i),
      gmv: Number((80000 * boost * (0.7 + rnd() * 0.6)).toFixed(2)),
      orders_cnt: Math.round(320 * boost * (0.7 + rnd() * 0.6)),
      pay_users: Math.round(260 * boost * (0.7 + rnd() * 0.5)),
      uv: Math.round(8600 * boost * (0.75 + rnd() * 0.5)),
      pv: Math.round(32000 * boost * (0.75 + rnd() * 0.5)),
    }
  }),
}

/* ---------- 汇总 ---------- */
export const DEMO_SERVER_VERSION = '8.0.36 (Demo)'

export const DEMO_SCHEMAS: DemoSchemaDef[] = [
  {
    name: 'shop',
    comment: '电商业务库',
    tables: [shopUsers, shopCategories, shopProducts, shopOrders, shopOrderItems, shopPayments, shopVOrderDetail],
  },
  {
    name: 'blog',
    comment: '内容社区库',
    tables: [blogArticles, blogComments, blogTags, blogArticleTags, blogVHot],
  },
  {
    name: 'analytics',
    comment: '数据分析库（汇总层）',
    tables: [analyticsDaily],
  },
]

export const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']
