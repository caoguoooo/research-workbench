import test from 'node:test';
import assert from 'node:assert/strict';
import { inferredBasicInfo, validLocation, distanceMeters, distanceLabel, educationSchoolType, isVisibleAmenity, educationSummary } from '../project-details.js';

test('legacy summaries supply project facts without modifying the original archive', () => {
  const item = { summary: '容积率1.92，绿化率23%。装修：暂无。\n开盘记录：2026年9月；交付记录：2028年5月（来源页）', floorplans: [{ area: '86㎡', rooms: '3房' }, { area: '86㎡', rooms: '3房' }], basicInfo: { decoration: '', greenRate: '25%' } };
  const original = structuredClone(item), info = inferredBasicInfo(item);
  assert.equal(info.primaryLayouts, '3房 / 86㎡');
  assert.equal(info.plotRatio, '1.92'); assert.equal(info.greenRate, '25%');
  assert.equal(info.decoration, ''); assert.equal(info.openingDate, '2026年9月');
  assert.equal(info.deliveryDate, '2028年5月'); assert.deepEqual(item, original);
});

test('map distances reject missing coordinates and handle zero and antipodal coordinates', () => {
  assert.equal(validLocation({ lat: 0, lng: 0 }), true);
  assert.equal(validLocation({ lat: '0', lng: '0' }), false);
  assert.equal(validLocation({ lat: 91, lng: 0 }), false);
  assert.equal(distanceMeters(null, { lat: 0, lng: 0 }), null);
  assert.equal(distanceLabel(null), '未定位');
  assert.equal(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
  const distance = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(distance > 111000 && distance < 111300);
  assert.equal(distanceLabel(distance), '111.2 公里');
  assert.ok(Number.isFinite(distanceMeters({ lat: 45, lng: 0 }, { lat: -45, lng: 180 })));
});


test('education admits only kindergarten, primary and middle schools with type-aware legacy fallback', () => {
  for (const [value, expected] of [
    [{name:'实验学校',typecode:'141203'},'primary'],
    [{name:'重庆育才学校',type:'科教文化服务;学校;中学'},'secondary'],
    [{name:'师大附小'},'primary'], [{name:'大学附属小学'},'primary'],
    [{name:'南门小学'},'primary'], [{name:'实验幼儿园'},'kindergarten'],
    [{name:'九年一贯制学校'},'secondary'], [{name:'第一高级中学'},'secondary'],
    [{name:'实验学校',schoolType:'primary'},'primary'],
    [{name:'小学驾驶培训',typecode:'141203'},null], [{name:'某驾校',typecode:'141500'},null],
    [{name:'XX小学辅导班'},null], [{name:'XX幼儿园停车场'},null],
    [{name:'第一中学(北门)'},null], [{name:'儿童早教中心'},null],
    [{name:'XX职业中学'},null], [{name:'师范大学',typecode:'141201'},null],
    [{name:'中学体育馆',typecode:'141207'},null], [{name:'实验学校'},null],
    [{name:'第一小学',typecode:'141500'},null]
  ]) assert.equal(educationSchoolType(value),expected,JSON.stringify(value));
  assert.equal(isVisibleAmenity({name:'某驾校',category:'education'}),false);
  assert.equal(isVisibleAmenity({name:'某中学公交站',category:'transport'}),true);
});

test('legacy generated education descriptions are re-rendered without driving schools and leave stored notes untouched', () => {
  const amenities={summary:{education:'学区需另行核实\n高德周边（2公里）：旧驾校、第一小学、某大学'},places:[
    {name:'旧驾校',category:'education'}, {name:'第一小学',category:'education'},
    {name:'实验幼儿园',category:'education'}, {name:'第二中学',category:'education'},
    {name:'某大学',category:'education'}, {name:'艺术培训学校',category:'education'}
  ]};
  const before=structuredClone(amenities);
  assert.equal(educationSummary(amenities),'学区需另行核实\n高德周边（2公里）：第一小学、实验幼儿园、第二中学');
  assert.deepEqual(amenities,before);
  assert.equal(educationSummary({summary:{education:'仅保留人工说明'}}),'仅保留人工说明');
  assert.doesNotMatch(educationSummary({...amenities,places:[]}),/旧驾校|某大学/);
});
