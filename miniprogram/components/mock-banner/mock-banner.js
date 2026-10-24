// 模拟模式提示，避免把模拟数据误认为真实发布
const api = require('../../services/api');

Component({
  data: { show: api.isMock },
});
