// M0-6 体积对照 · 上限基准
// 把整个 three 挂到 window 上，迫使打包器无法 tree-shake 掉任何成员。
// 用途：量化 tree-shaking 到底省了多少，从而判断"为体积优化 import 写法"是否值得投入。
import * as THREE from 'three';

window.THREE = THREE;
document.title = 'full ' + String(THREE.REVISION);
