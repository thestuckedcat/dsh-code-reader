// Source-reviewed annotations for bus.c and platform.c in this fixture.
// Resource links describe possible access, independent of the simulated run.
const resourceLinks = {
  routes: {
    field: 'routes[channel].lane / .max_len',
    writers: [
      ['reset', '初始化', '所有槽位清零'],
      ['bus_register', '登记写入', '复制默认 lane / max_len', ['store_route']],
      ['stub_route', '写入或覆盖', '使用入参 lane / max_len', ['store_route']],
      ['bus_unregister', '去初始化', 'lane = 0，max_len = 0', ['store_route']],
    ],
    readers: [
      ['bus_send', '读取', '查表、校验长度、取 lane', ['lookup_route', 'check_length', 'dispatch_transfer']],
    ],
  },
  route_defaults: {
    field: 'route_defaults[channel].lane / .max_len',
    initial: 'C 静态初始化',
    readers: [['bus_register', '读取', '选择对应通道的默认配置']],
  },
  transfer_lock: {
    field: 'transfer_lock',
    writers: [['reset', '初始化', '清零'], ['bus_send', '进入 / 退出', '提交前置 1，提交后清零']],
    readers: [['bus_send', '读取', '记录模拟保护区状态']],
  },
  staged_lengths: {
    field: 'staged_lengths[lane]',
    writers: [['reset', '初始化', '所有槽位清零'], ['bus_send', '写入', '长包分支，暂存 length', ['stage_payload']]],
    readers: [['bus_send', '读取', '读回待提交长度', ['stage_payload']]],
  },
  irq_count: {
    field: 'irq_count',
    writers: [['reset', '初始化', '计数清零'], ['bus_irq', '读改写', '计数递增']],
    readers: [['bus_irq', '读取', '记录递增后的值']],
  },
  platform_status: {
    field: 'platform_status',
    writers: [['platform_reset', '初始化', '恢复成功返回'], ['set_platform_stub', '修改', '写入打桩返回码']],
    readers: [['platform_write', '读取', '非零时提前返回']],
  },
  simulated_doorbell: {
    field: 'simulated_doorbell',
    writers: [['platform_reset', '初始化', '模拟寄存器清零'], ['platform_write', '写入', '成功路径写入编码值']],
    readers: [['platform_write', '读取', '记录原值与新值']],
  },
};

const externalTerminals = [
  ['bus_send', '设备提交', 'platform_write'],
  ['reset', '平台初始化', 'platform_reset'],
];

// Field meanings are inferred from the fixture's readers and writers.
const resourcePresentation = {
  route_defaults: {
    colors: ['#553e22', '#ffd08a'], intro: '各通道的默认路由',
    fields: {
      lane: ['登记时复制到运行时路由的默认发送通道。', 'bus_register() 读取默认项并把 lane 传给 store_route()。'],
      max_len: ['登记时复制到运行时路由的默认长度上限，单位为字节。', 'bus_register() 保存 max_len，后续 check_length() 将它与请求长度比较。'],
    },
  },
  routes: {
    colors: ['#20436a', '#97ccff'], intro: '已登记通道的运行时路由',
    fields: {
      lane: ['发送使用的通道编号。长包用它索引暂存槽，提交时它进入门铃高 16 位。', 'dispatch_transfer() 传递 lane，stage_payload() 用它索引暂存槽，encode_doorbell() 左移 16 位。'],
      max_len: ['发送长度上限，单位为字节。为 0 时视为未登记。', 'lookup_route() 以零值判断未登记，check_length() 用该字段比较请求长度。'],
    },
  },
  transfer_lock: { colors: ['#472e68', '#d8b5ff'], intro: '标记发送提交的模拟保护区' },
  staged_lengths: { colors: ['#194d48', '#99e9d8'], intro: '按 lane 暂存长包长度' },
  irq_count: { colors: ['#562b4b', '#ffafe0'], intro: '累计模拟 IRQ 次数' },
  platform_status: { colors: ['#572e31', '#ffb3a7'], intro: '控制平台写入的打桩返回码' },
  simulated_doorbell: {
    colors: ['#354c24', '#cbeea5'], intro: '保存最近一次模拟门铃写值',
    bits: {
      '[31:16]': ['编码后的发送通道 lane。', 'encode_doorbell() 将 lane 左移 16 位。'],
      '[15:0]': ['提交的请求长度，单位为字节。', 'bus_send() 限定 length ≤ 65535，encode_doorbell() 将 length 与高位按位或。'],
    },
  },
};

// A string is a local step. A pair places a direct call under its control condition.
const readingSteps = {
  bus_send: [
    '记录 channel 和 length。channel 越界、length 为 0 或超过 65535 时返回 -22。',
    ['通过基本校验后查 routes[channel]', 'lookup_route'],
    '查表结果为空时返回 -2。',
    ['查表命中后检查该路由的长度上限', 'check_length'],
    '超过 max_len 时返回 -90。',
    ['写 transfer_lock = 1 后提交，并保存返回码', 'dispatch_transfer'],
    '提交返回后清除 transfer_lock，再返回提交结果，包含平台失败码。',
  ],
  bus_register: ['channel 越界返回 -22；有效时读取 route_defaults[channel]。',
    ['把默认 lane 与 max_len 写入运行时路由', 'store_route'], '返回 0。'],
  bus_unregister: ['channel 越界返回 -22。', ['把目标槽的 lane 与 max_len 清零', 'store_route'],
    '记录注销并返回 0。后续查表将该槽视为未登记。'],
  stub_route: ['channel 越界、lane > 3、max_len 为 0 或超过 65535 时返回 -22。',
    ['校验通过后保存入参配置', 'store_route'], '返回 0。'],
  bus_irq: ['递增 irq_count，记录 IRQ 事件并返回 0。该入口独立触发。'],
  reset: ['遍历所有槽位，清零 routes 与 staged_lengths；清零 transfer_lock 和 irq_count。',
    ['重置平台模拟资源', 'platform_reset']],
  lookup_route: ['取 routes[channel] 的地址并记录 lane 与 max_len。', 'max_len 非零时返回该路由；否则返回空指针。'],
  check_length: ['读取 route->max_len，比较 length ≤ max_len，记录并返回布尔结果。'],
  dispatch_transfer: [['length > 48 时走长包分支', 'submit_buffered'], ['length ≤ 48 时走短包分支', 'submit_direct']],
  submit_buffered: [['以路由的 lane 暂存请求长度', 'stage_payload'], ['用读回的长度提交', 'commit_transfer']],
  submit_direct: [['直接使用原请求长度提交', 'commit_transfer']],
  commit_transfer: [['把 lane 和 length 编码成门铃值', 'encode_doorbell'], ['写入并透传返回码', 'write_doorbell']],
  write_doorbell: [['把 TX_DOORBELL 与编码值交给平台库', 'platform_write']],
  platform_write: ['读取 platform_status。非零时直接返回该值。', '成功时读取旧值、更新 simulated_doorbell、记录前后值，返回 0。'],
};
