import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import fs from 'fs';

const loader = new GLTFLoader();

function getModelDimensions(gltf) {
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    width: size.x,
    height: size.y,
    depth: size.z,
    volume: size.x * size.y * size.z,
    center: box.getCenter(new THREE.Vector3())
  };
}

let loaded = 0;
const results = {};

loader.load('assets/zombie_running_on_metel_maniac.glb', (gltf) => {
  results.metalManiac = getModelDimensions(gltf);
  results.metalManiacName = 'Zombie on Metal Maniac';
  loaded++;
  if (loaded === 2) printResults();
}, undefined, () => {
  console.error('Failed to load metal maniac zombie');
});

loader.load('assets/animated_zombie_cop_running_loop.glb', (gltf) => {
  results.copRunning = getModelDimensions(gltf);
  results.copRunningName = 'Cop Running (Loop)';
  loaded++;
  if (loaded === 2) printResults();
}, undefined, () => {
  console.error('Failed to load cop running');
});

function printResults() {
  console.log('\n=== MODEL SIZE COMPARISON ===\n');
  
  console.log(`${results.metalManiacName}:`);
  console.log(`  Width: ${results.metalManiac.width.toFixed(3)}m`);
  console.log(`  Height: ${results.metalManiac.height.toFixed(3)}m`);
  console.log(`  Depth: ${results.metalManiac.depth.toFixed(3)}m`);
  console.log(`  Volume: ${results.metalManiac.volume.toFixed(3)}m³`);
  
  console.log(`\n${results.copRunningName}:`);
  console.log(`  Width: ${results.copRunning.width.toFixed(3)}m`);
  console.log(`  Height: ${results.copRunning.height.toFixed(3)}m`);
  console.log(`  Depth: ${results.copRunning.depth.toFixed(3)}m`);
  console.log(`  Volume: ${results.copRunning.volume.toFixed(3)}m³`);
  
  const heightRatio = results.metalManiac.height / results.copRunning.height;
  const volumeRatio = results.metalManiac.volume / results.copRunning.volume;
  
  console.log(`\n=== RATIOS ===`);
  console.log(`Height ratio: ${heightRatio.toFixed(2)}x (Metal Maniac is ${heightRatio > 1 ? 'larger' : 'smaller'})`);
  console.log(`Volume ratio: ${volumeRatio.toFixed(2)}x`);
  
  process.exit(0);
}
