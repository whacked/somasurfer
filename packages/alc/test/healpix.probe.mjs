import { ang2pixNest, pix2angNest, npix, parentPix, toVector, fromVector, pixelSolidAngle } from '../src/healpix.ts';

function rngFactory(seed){ let s=seed>>>0; return ()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; }; }
const rnd = rngFactory(42);
let fails=0;
const N=20000;

// 1. round-trip stability: ang2pix(pix2ang(ang2pix(d))) == ang2pix(d)
for (const order of [0,1,2,4,6,8]) {
  let bad=0;
  for (let i=0;i<N;i++){
    const z = 2*rnd()-1, phi = 2*Math.PI*rnd(), theta = Math.acos(z);
    const p = ang2pixNest(theta, phi, order);
    if (p<0 || p>=npix(order)) { bad++; continue; }
    const c = pix2angNest(p, order);
    const p2 = ang2pixNest(c.theta, c.phi, order);
    if (p2 !== p) bad++;
  }
  console.log(`order ${order}: npix=${npix(order)} roundtrip-centre failures ${bad}/${N}`);
  fails += bad;
}

// 2. hierarchy / prefix property: ang2pix(d,k)>>2 == ang2pix(d,k-1)
for (const order of [1,2,3,5,7,9]) {
  let bad=0;
  for (let i=0;i<N;i++){
    const z=2*rnd()-1, phi=2*Math.PI*rnd(), theta=Math.acos(z);
    if (parentPix(ang2pixNest(theta,phi,order)) !== ang2pixNest(theta,phi,order-1)) bad++;
  }
  console.log(`order ${order}: prefix-property failures ${bad}/${N}`);
  fails += bad;
}

// 3. coverage: every pixel index at order 3 is hit by random sampling
const order=3, seen=new Set();
for (let i=0;i<400000;i++){
  const z=2*rnd()-1, phi=2*Math.PI*rnd();
  seen.add(ang2pixNest(Math.acos(z),phi,order));
}
console.log(`order 3: distinct pixels hit ${seen.size}/${npix(order)}`);
if (seen.size !== npix(order)) fails++;

// 4. equal area check via Monte Carlo at order 2 (192 pixels)
{
  const o=2, counts=new Array(npix(o)).fill(0), M=2_000_000;
  for (let i=0;i<M;i++){ const z=2*rnd()-1, phi=2*Math.PI*rnd(); counts[ang2pixNest(Math.acos(z),phi,o)]++; }
  const exp=M/npix(o);
  const dev=counts.map(c=>Math.abs(c-exp)/exp);
  const maxDev=Math.max(...dev);
  console.log(`order 2 equal-area: max relative deviation ${(maxDev*100).toFixed(2)}% (MC noise ~${(100/Math.sqrt(exp)).toFixed(2)}%)`);
  if (maxDev > 0.05) fails++;
}

// 5. centre of pixel must lie inside the pixel (already test 1) + neighbouring order consistency
console.log(`pixel solid angle order 6: ${pixelSolidAngle(6).toExponential(3)} sr`);

// cortical area per cell, one hemisphere pial surface ~ 90,000 mm^2
for (const k of [2,4,6,8]) {
  const a = 90000/npix(k);
  console.log(`  order ${k}: ${npix(k)} cells/hemi, mean cortical area ${a.toFixed(3)} mm^2, equiv square ${Math.sqrt(a).toFixed(2)} mm, code chars ${1+k/2}`);
}
console.log(fails===0 ? 'ALL HEALPIX CHECKS PASSED' : `FAILURES: ${fails}`);
