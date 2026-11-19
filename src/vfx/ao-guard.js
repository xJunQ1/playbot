// ═══════════════════════════════════════════════════════════
//  让「加色透明」的特效不进环境光遮蔽（GTAO）的预通道
//
//  背景：GTAO 会用一个不透明的「法线覆盖材质」把整个场景再渲一遍取法线/深度。
//  加色透明的薄片（剑轨、刀光、命中闪光、火星）在这一遍里被当成实心几何，
//  AO 于是在它下方糊出一块黑斑 —— 就是玩家看到的「打击时出现黑色特效」。
//
//  做法：在 onBeforeRender 里判断「当前材质不是我自己那个」= 正在被覆盖材质渲染，
//  那一遍把几何的 drawRange 清零（Sprite 就临时隐藏），正常渲染再恢复。
// ═══════════════════════════════════════════════════════════
export function guardFromAO(object, ownMaterial) {
  if (!object || !ownMaterial) return object;
  let savedRange = null;
  let savedVisible = null;

  object.onBeforeRender = (renderer, scene, camera, geometry, material) => {
    if (material === ownMaterial) return;                 // 正常渲染，放行
    if (geometry && geometry.drawRange) {
      savedRange = geometry.drawRange.count;
      geometry.setDrawRange(0, 0);
    } else {
      savedVisible = object.visible;
      object.visible = false;
    }
  };

  object.onAfterRender = (renderer, scene, camera, geometry, material) => {
    if (material === ownMaterial) return;
    if (geometry && savedRange !== null) {
      geometry.setDrawRange(0, savedRange);
      savedRange = null;
    } else if (savedVisible !== null) {
      object.visible = savedVisible;
      savedVisible = null;
    }
  };

  return object;
}
