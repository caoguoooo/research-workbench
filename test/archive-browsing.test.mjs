import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSearchState, previewGallery, clampPreviewPan, createArchiveDetailLoader } from '../competitor.js';

test('rapid project selection ignores late success/error responses and permits a fresh retry', async () => {
  const pending = new Map();
  const loader = createArchiveDetailLoader(id => new Promise((resolve,reject) => pending.set(id,{resolve,reject})));
  const a = loader.load('a'), b = loader.load('b');
  assert.equal(loader.state.loading,true); assert.equal(loader.state.item,null);
  pending.get('b').resolve({id:'b',name:'当前项目'});
  assert.equal(await b,true); assert.equal(loader.state.item.id,'b');
  pending.get('a').resolve({id:'a',name:'慢请求'});
  assert.equal(await a,false); assert.equal(loader.state.item.id,'b');
  const c = loader.load('c'), d = loader.load('d');
  pending.get('c').reject(new Error('已过时的失败'));
  assert.equal(await c,false); assert.equal(loader.state.id,'d'); assert.equal(loader.state.error,'');
  pending.get('d').reject(new Error('暂时不可用')); await d;
  assert.equal(loader.state.item,null); assert.equal(loader.state.error,'暂时不可用');
  const retry = loader.load('d'); pending.get('d').resolve({id:'d',name:'重试成功'}); await retry;
  assert.equal(loader.state.error,''); assert.equal(loader.state.item.name,'重试成功');
  const e = loader.load('e'); loader.clear(); pending.get('e').resolve({id:'e'});
  assert.equal(await e,false); assert.equal(loader.state.id,null);
});

test('search hides a stale detail, preserves a matching selection, and restores selection when cleared', () => {
  const records = [{id:'cq',name:'远达澜庭序',city:'重庆',district:'两江新区'}, {id:'xa',name:'龙翔未央和鸣',city:'西安'}];
  assert.equal(archiveSearchState(records, 'xa', '澜庭').item, null);
  assert.equal(archiveSearchState(records, 'xa', '澜庭').count, 1);
  assert.equal(archiveSearchState(records, 'cq', '重庆').item, records[0]);
  assert.deepEqual(archiveSearchState(records, 'xa', '无结果'), {groups:[],count:0,item:null});
  assert.equal(archiveSearchState(records, 'xa', '').item, records[1]);
  assert.equal(archiveSearchState([], null, '').item, null);
});

test('preview follows displayed floorplan order, omits empty slots and superseded images, stays within category', () => {
  const image = (id, category, slotId) => ({id,category,slotId,type:'image/png',name:id});
  const old=image('old','户型图','a'), a=image('a-new','户型图','a'), b=image('b','户型图','b'), render=image('r','效果图');
  const item={floorplans:[{id:'a',label:'143㎡'},{id:'empty',label:'待补'},{id:'b',label:'195㎡'}],files:[b,old,render,a]};
  assert.deepEqual(previewGallery(item,a).map(x=>[x.file.id,x.label]),[['a-new','143㎡'],['b','195㎡']]);
  assert.deepEqual(previewGallery(item,render).map(x=>x.file.id),['r']);
  assert.deepEqual(previewGallery(item,old).map(x=>x.file.id),['old']);
  const before=JSON.stringify(item);previewGallery(item,b);assert.equal(JSON.stringify(item),before);
});

test('preview gallery keeps original rendering order and excludes non-image attachments', () => {
  const item={floorplans:[],files:[{id:'1',category:'效果图',type:'image/jpeg'},{id:'pdf',category:'效果图',type:'application/pdf'},{id:'2',category:'效果图',type:'image/png'}]};
  assert.deepEqual(previewGallery(item,item.files[0]).map(x=>[x.file.id,x.label]),[['1','效果图 01'],['2','效果图 02']]);
});

test('zoomed image pan is bounded; smaller-than-window axes stay centered', () => {
  assert.deepEqual(clampPreviewPan(300,-500,1000,1600,600,800),{x:200,y:-400});
  assert.deepEqual(clampPreviewPan(100,100,400,600,600,800),{x:0,y:0});
  assert.deepEqual(clampPreviewPan(-200,15,1000,700,600,800),{x:-200,y:0});
});

test('city and district filters intersect with search and keep Chongqing categories separate', () => {
  const records = [
    {id:'main',name:'澜庭',city:'重庆',district:'两江新区'},
    {id:'county',name:'澜庭区县',city:'重庆',district:'璧山区'},
    {id:'other',name:'另一个项目',city:'重庆',district:'渝北区'},
    {id:'xa',name:'澜庭西安',city:'西安',district:'城北'}
  ];
  const before = JSON.stringify(records);
  assert.equal(archiveSearchState(records,'county','澜庭',{city:'重庆主城'}).item,null);
  assert.deepEqual(archiveSearchState(records,'main','澜庭',{city:'重庆主城'}).groups.flatMap(g=>g.items.map(i=>i.id)),['main']);
  assert.equal(archiveSearchState(records,'main','',{city:'重庆主城',district:'两江新区'}).item,records[0]);
  assert.equal(archiveSearchState(records,'main','',{city:'重庆主城',district:'渝北区'}).item,null);
  assert.equal(archiveSearchState(records,'main','不存在',{city:'重庆主城'}).count,0);
  assert.equal(archiveSearchState(records,'county','',{city:'重庆区县',district:'璧山区'}).item,records[1]);
  assert.equal(archiveSearchState(records,'county','').item,records[1]);
  assert.equal(JSON.stringify(records),before);
});

test('filter choices use the same city/district labels, counts and descending district order as the directory', async () => {
  const { archiveFilterOptions } = await import('../competitor.js');
  const records = [
    {id:'1',name:'A',city:'重庆',district:'两江新区'},
    {id:'2',name:'B',city:'重庆',district:'两江新区'},
    {id:'3',name:'C',city:'重庆',district:'渝北区'},
    {id:'4',name:'D',city:'重庆',district:'璧山区'},
    {id:'5',name:'E',city:'西安市',district:''}
  ];
  const choices=archiveFilterOptions(records,'重庆主城');
  assert.deepEqual(choices.cities.filter(c=>c.value.startsWith('重庆')),[{value:'重庆主城',count:3},{value:'重庆区县',count:1}]);
  assert.deepEqual(choices.districts,[{value:'两江新区',count:2},{value:'渝北区',count:1}]);
  assert.deepEqual(archiveFilterOptions(records).districts,[]);
  assert.deepEqual(archiveFilterOptions(records,'西安').districts,[{value:'未划分区位',count:1}]);
  assert.deepEqual(archiveFilterOptions([], '已删除城市'),{cities:[],districts:[]});
});
