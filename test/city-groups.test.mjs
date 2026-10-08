import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCompetitorsByCity } from '../competitor.js';

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
