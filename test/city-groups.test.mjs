import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCompetitorsByCity, groupCompetitorsByDistrict } from '../competitor.js';

test('竞品目录按城市分组，统一市后缀，未填城市排在最后', () => {
  const items = [
    { id: 'a', name: '重庆楼盘', city: '重庆市' },
    { id: 'b', name: '成都项目一', city: '成都' },
    { id: 'c', name: '成都项目二', city: ' 成都市 ' },
    { id: 'd', name: '位置待补充', city: '' }
  ];
  const before = JSON.stringify(items);
  const groups = groupCompetitorsByCity(items);
  assert.deepEqual(groups.map(group => [group.city, group.items.map(item => item.id)]), [['成都', ['b', 'c']], ['重庆', ['a']], ['未分类', ['d']]]);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(groupCompetitorsByCity(items, '成都').flatMap(group => group.items.map(item => item.id)), ['b', 'c']);
  assert.deepEqual(groupCompetitorsByCity(items, '项目二').flatMap(group => group.items.map(item => item.id)), ['c']);
  assert.deepEqual(groupCompetitorsByCity(items, '没有结果'), []);
});


test('区位按项目数量降序，归一空白且不修改档案', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'a', district: ' 两江新区 ' }),
    Object.freeze({ id: 'b', district: '南岸' }),
    Object.freeze({ id: 'c', district: '两江新区' }),
    Object.freeze({ id: 'd', district: ' ' }),
    Object.freeze({ id: 'e' })
  ]);
  const groups = groupCompetitorsByDistrict(items);
  assert.deepEqual(groups.map(group => [group.district, group.items.map(item => item.id)]), [
    ['两江新区', ['a', 'c']], ['未划分区位', ['d', 'e']], ['南岸', ['b']]
  ]);
  assert.equal(groups[0].items[0], items[0]);
  assert.equal(items[0].district, ' 两江新区 ');
  assert.deepEqual(groupCompetitorsByDistrict([]), []);
});

test('城市下的区位各自独立，名称、区位和开发商搜索只保留匹配项目', () => {
  const items = [
    { id: 'a', name: '甲项目', city: '重庆', district: '高新区', developer: '甲开发商' },
    { id: 'b', name: '乙项目', city: '成都', district: '高新区', developer: '乙开发商' },
    { id: 'c', name: '丙项目', city: '重庆市', district: '南岸', developer: '甲开发商' }
  ];
  const tree = query => groupCompetitorsByCity(items, query).map(group => ({
    city: group.city,
    districts: groupCompetitorsByDistrict(group.items).map(district => [district.district, district.items.map(item => item.id)])
  }));
  assert.deepEqual(tree('高新区'), [
    { city: '成都', districts: [['高新区', ['b']]] },
    { city: '重庆', districts: [['高新区', ['a']]] }
  ]);
  assert.deepEqual(tree('丙项目'), [{ city: '重庆', districts: [['南岸', ['c']]] }]);
  assert.deepEqual(tree('甲开发商'), [{ city: '重庆', districts: [['高新区', ['a']], ['南岸', ['c']]] }]);
});


test('区位优先按项目总数降序，同数量按名称排序', () => {
  const items = [
    { id: 'a', name: '一', city: '重庆', district: '南岸' },
    { id: 'b', name: '二', city: '重庆', district: '两江新区' },
    { id: 'c', name: '三', city: '重庆', district: '两江新区' },
    { id: 'd', name: '四', city: '重庆', district: '九龙坡' },
    { id: 'e', name: '五', city: '重庆', district: '两江新区' },
    { id: 'f', name: '六', city: '重庆', district: '南岸' }
  ];
  assert.deepEqual(groupCompetitorsByDistrict(items).map(group => [group.district, group.items.length]), [['两江新区', 3], ['南岸', 2], ['九龙坡', 1]]);
});
