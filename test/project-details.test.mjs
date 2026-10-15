import test from 'node:test';
import assert from 'node:assert/strict';
import { inferredBasicInfo, validLocation, distanceMeters, distanceLabel } from '../project-details.js';

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
