import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMapProject, mergeMapAmenities, collectProjectMap } from '../map-refresh.mjs';
const point = (name, lng = 106.5, address = '重庆市两江新区') => ({ name, address, category: 'project', location: { lat: 29.6, lng }, sourceUrl: 'https://www.amap.com/place/B123' });

test('map matching checks city and project identity, excludes attached facilities and rejects distant duplicate names', () => {
  const item = { name: '远达·澜庭序', city: '重庆' };
  assert.equal(matchMapProject(item, [point('远达澜庭序停车场'), point('远达澜庭序销售中心')]).place.name, '远达澜庭序销售中心');
  assert.equal(matchMapProject(item, [point('澜庭序')]).place.name, '澜庭序');
  assert.equal(matchMapProject(item, [point('远达澜庭序', 106.5, '成都市')]).place, undefined);
  assert.equal(matchMapProject(item, [point('远达澜庭序', 106.5), point('远达澜庭序', 106.7)]).place, undefined);
  assert.equal(matchMapProject({ name: '观宸', city: '重庆' }, [point('观宸销售中心')]).place.name, '观宸销售中心');
  assert.equal(matchMapProject({ name: '观宸', city: '重庆' }, [point('观宸千山序')]).place, undefined);
});

test('map refresh replaces provider points, keeps custom places and notes, and does not grow summaries on repeat', async () => {
  const item = { name: '测试楼盘', city: '重庆', amenities: { summary: { education: '学区需另行核实' }, places: [{ ...point('手工点位'), category: 'shopping', sourceUrl: '' }, { ...point('过期高德点位'), category: 'transport' }] } };
  const fresh = [{ ...point('测试小学'), category: 'education' }];
  const service = { async search() { return { places: [point('测试楼盘')] }; }, async nearby(project) { assert.deepEqual(project.amenities.location, point('').location); return { places: fresh }; } };
  const result = await collectProjectMap(item, service);
  assert.equal(result.matched, true); assert.equal(result.amenities.places.length, 2);
  assert.match(result.amenities.summary.education, /学区需另行核实/);
  assert.deepEqual(mergeMapAmenities({ amenities: result.amenities }, result.amenities.location, fresh), result.amenities);
  assert.deepEqual(item.amenities.summary, { education: '学区需另行核实' });
  const unmatched = await collectProjectMap(item, { async search() { return { places: [] }; }, nearby() { assert.fail('No nearby query for an unverified project'); } });
  assert.equal(unmatched.matched, false);
});

test('developer-prefixed names re-query the shared project name instead of choosing a phase', async () => {
  const queries = [];
  const point = name => ({name,address:'重庆市 两江新区',location:{lat:29.75,lng:106.53}});
  const result = await collectProjectMap({name:'万华麓悦江城',city:'重庆'}, {
    async search(item, query) { queries.push(query); return {places: query === '万华麓悦江城' ? [point('麓悦江城麓溪半岛'),point('麓悦江城碧影溪')] : [point('麓悦江城')]}; },
    async nearby() {return {places:[]};}
  });
  assert.deepEqual(queries,['万华麓悦江城','麓悦江城']);
  assert.equal(result.place.name,'麓悦江城');
});
