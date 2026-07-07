import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const IMAGE_WIDTH = 2462;
const IMAGE_HEIGHT = 2028;
const SCALE = 150;
const canvas = document.querySelector("#scene");
const selectedValue = document.querySelector("#selectedValue");
const shopName = document.querySelector("#shopName");
const shopDescription = document.querySelector("#shopDescription");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f8fa);

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, -4.2, 14.8);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minPolarAngle = 0.08;
controls.minDistance = 5;
controls.maxDistance = 24;
controls.maxPolarAngle = Math.PI * 0.56;
controls.rotateSpeed = 0.82;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 2.7));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-3, -6, 9);
keyLight.castShadow = true;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xdbeafe, 1.1);
fillLight.position.set(8, 5, 6);
scene.add(fillLight);

const floorTexture = new THREE.TextureLoader().load("./europa-floor-plan-reference.jpg");
floorTexture.colorSpace = THREE.SRGBColorSpace;
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(IMAGE_WIDTH / SCALE, IMAGE_HEIGHT / SCALE),
  new THREE.MeshBasicMaterial({ map: floorTexture, transparent: true, opacity: 0.24 }),
);
floor.position.z = -0.08;
scene.add(floor);

const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.88 });
const shops = new THREE.Group();
scene.add(shops);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const meshes = [];
let hovered = null;
let selected = null;
let topDrag = null;

const palette = {
  blue: "#cbd9f6",
  cyan: "#c8eef1",
  mint: "#cfeeca",
  lilac: "#d9c8f3",
  pink: "#f4c4d0",
  rose: "#f4c8d1",
  peach: "#f5d8b5",
  cream: "#f8dfb5",
  orange: "#f4c994",
  gray: "#d8e1ef",
  lavender: "#ead2f4",
};

function point([x, y]) {
  return new THREE.Vector2((x - IMAGE_WIDTH / 2) / SCALE, (IMAGE_HEIGHT / 2 - y) / SCALE);
}

function rect(x, y, w, h) {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function makeLabel(text, position, size = 0.42) {
  const pixelRatio = 2;
  const width = 420;
  const height = 130;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = width * pixelRatio;
  labelCanvas.height = height * pixelRatio;
  const ctx = labelCanvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.font = `700 ${text.length > 12 ? 30 : 36}px Inter, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = text.split(" ");
  const lines = words.length > 1 && text.length > 10 ? [words.slice(0, -1).join(" "), words.at(-1)] : [text];
  lines.forEach((line, index) => ctx.fillText(line, width / 2, height / 2 + (index - (lines.length - 1) / 2) * 34));

  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.position.copy(position);
  sprite.position.z += 0.24;
  sprite.scale.set(size * 3.2, size, 1);
  return sprite;
}

function centroid(points) {
  const total = points.reduce(
    (acc, item) => {
      acc.x += item[0];
      acc.y += item[1];
      return acc;
    },
    { x: 0, y: 0 },
  );
  return point([total.x / points.length, total.y / points.length]);
}

function addShop({ name, category = "Tenant", color, points, height = 0.24, labelSize = 0.42, showLabel = true }) {
  const baseColor = new THREE.Color(color);
  const topColor = baseColor.clone().multiplyScalar(0.86);
  const shape = new THREE.Shape(points.map(point));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSize: 0.025,
    bevelThickness: 0.018,
    bevelSegments: 2,
  });
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: topColor,
    roughness: 0.68,
    metalness: 0.03,
    transparent: true,
    opacity: 0.96,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { name, category, baseColor: color, height };
  shops.add(mesh);
  meshes.push(mesh);

  const outlinePoints = points.map(point);
  outlinePoints.push(outlinePoints[0].clone());
  const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(outlinePoints), outlineMaterial);
  outline.position.z = height + 0.012;
  shops.add(outline);

  const borderShape = new THREE.Shape(points.map(point));
  const borderGeometry = new THREE.ExtrudeGeometry(borderShape, {
    depth: 0.018,
    bevelEnabled: false,
  });
  const borderEdges = new THREE.EdgesGeometry(borderGeometry, 8);
  const border = new THREE.LineSegments(
    borderEdges,
    new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.52 }),
  );
  border.position.z = height + 0.016;
  shops.add(border);

  if (showLabel) {
    const center = centroid(points);
    shops.add(makeLabel(name, new THREE.Vector3(center.x, center.y, height), labelSize));
  }
}

function addBlock(names, x, y, w, h, columns, color, category, labelSize = 0.34) {
  const rows = Math.ceil(names.length / columns);
  const cellW = w / columns;
  const cellH = h / rows;
  names.forEach((name, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    addShop({
      name,
      category,
      color,
      points: rect(x + col * cellW, y + row * cellH, cellW, cellH),
      height: 0.18,
      labelSize,
    });
  });
}

function addRow(names, x, y, widths, height, color, category, labelSize = 0.34) {
  let cursor = x;
  names.forEach((name, index) => {
    addShop({
      name,
      category,
      color,
      points: rect(cursor, y, widths[index], height),
      height: 0.18,
      labelSize,
    });
    cursor += widths[index];
  });
}

addShop({ name: "MAXIMA", category: "Grocery", color: palette.gray, points: [[1282, 268], [2170, 238], [2194, 256], [2194, 636], [2176, 655], [1510, 683], [1370, 660], [1351, 505], [1305, 505], [1305, 410], [1288, 410]], height: 0.34, labelSize: 0.78 });
addShop({ name: "MAXIMA side", category: "Retail", color: palette.gray, points: [[2016, 702], [2264, 692], [2264, 800], [2040, 868], [2022, 870]], height: 0.2, showLabel: false });

addShop({ name: "Duglas", category: "Retail", color: palette.lavender, points: [[625, 330], [785, 312], [792, 516], [745, 516], [622, 405]], height: 0.2, labelSize: 0.29 });
addShop({ name: "Telia", category: "Retail", color: palette.lavender, points: [[785, 312], [920, 307], [920, 518], [792, 516]], height: 0.2, labelSize: 0.31 });
addShop({ name: "iDeal", category: "Retail", color: palette.blue, points: [[920, 307], [1052, 302], [1054, 518], [920, 518]], height: 0.2, labelSize: 0.31 });
addShop({ name: "Salamander", category: "Retail", color: palette.cyan, points: [[1052, 302], [1216, 294], [1220, 496], [1182, 548], [1092, 520], [1054, 518]], height: 0.2, labelSize: 0.31 });

addShop({ name: "GUESS", category: "Fashion", color: palette.blue, points: [[350, 505], [514, 500], [611, 583], [611, 627], [354, 633]], height: 0.21, labelSize: 0.31 });
addShop({ name: "TOMMY HILFIGER", category: "Fashion", color: palette.blue, points: [[354, 633], [611, 627], [615, 738], [358, 741]], height: 0.21, labelSize: 0.29 });
addShop({ name: "Calvin Klein", category: "Fashion", color: palette.lavender, points: [[358, 741], [615, 738], [620, 850], [362, 854]], height: 0.21, labelSize: 0.31 });
addShop({ name: "Marc O'Polo", category: "Fashion", color: palette.mint, points: [[362, 854], [620, 850], [624, 960], [366, 965]], height: 0.21, labelSize: 0.31 });
addShop({ name: "Tamaris", category: "Fashion", color: palette.cyan, points: [[366, 965], [624, 960], [629, 1074], [371, 1080]], height: 0.21, labelSize: 0.31 });
addShop({ name: "ECCO", category: "Fashion", color: palette.blue, points: [[371, 1080], [629, 1074], [633, 1190], [375, 1195]], height: 0.21, labelSize: 0.31 });
addShop({ name: "ecco", category: "Fashion", color: palette.blue, points: [[375, 1195], [633, 1190], [636, 1298], [380, 1302], [373, 1288]], height: 0.21, labelSize: 0.3 });

addRow(["Lindex", "Selected", "VILA"], 732, 586, [130, 130, 128], 110, palette.lavender, "Fashion", 0.3);
addRow(["Hugo", "Only", "Jack Jones"], 734, 696, [132, 132, 124], 115, palette.cream, "Fashion", 0.3);
addShop({ name: "Promod", category: "Fashion", color: palette.cream, points: rect(736, 811, 135, 122), height: 0.18, labelSize: 0.3 });
addShop({ name: "Jack & Jones", category: "Fashion", color: palette.cream, points: rect(871, 811, 259, 122), height: 0.18, labelSize: 0.32 });
addShop({ name: "Promod", category: "Fashion", color: palette.cream, points: rect(738, 933, 138, 128), height: 0.18, labelSize: 0.3 });
addShop({ name: "Mango", category: "Fashion", color: palette.cream, points: rect(876, 933, 257, 128), height: 0.18, labelSize: 0.32 });
addShop({ name: "Mohito", category: "Fashion", color: palette.cream, points: rect(740, 1061, 142, 124), height: 0.18, labelSize: 0.3 });
addShop({ name: "Bershka", category: "Fashion", color: palette.cream, points: rect(882, 1061, 253, 124), height: 0.18, labelSize: 0.32 });
addShop({ name: "Pull&Bear", category: "Fashion", color: palette.cream, points: rect(742, 1185, 148, 125), height: 0.18, labelSize: 0.3 });
addShop({ name: "Stradivarius", category: "Fashion", color: palette.cream, points: rect(890, 1185, 246, 125), height: 0.18, labelSize: 0.32 });

addShop({ name: "ZARA", category: "Fashion", color: palette.peach, points: [[1133, 610], [1208, 650], [1338, 774], [1450, 897], [1585, 978], [1585, 1150], [1450, 1197], [1368, 1248], [1300, 1310], [1179, 1310], [1175, 1252], [1127, 1252], [1127, 805], [1135, 805]], height: 0.36, labelSize: 0.74 });
addShop({ name: "Caffeine", category: "Services", color: palette.orange, points: [[1434, 976], [1580, 1028], [1580, 1096], [1434, 1096]], height: 0.2, labelSize: 0.28 });
addShop({ name: "Narvesen", category: "Services", color: palette.gray, points: [[1425, 1096], [1580, 1096], [1580, 1168], [1480, 1194], [1394, 1194]], height: 0.2, labelSize: 0.28 });
addShop({ name: "Optika", category: "Services", color: palette.gray, points: [[1394, 1194], [1480, 1194], [1580, 1168], [1580, 1222], [1410, 1290], [1364, 1238]], height: 0.2, labelSize: 0.28 });

addShop({ name: "BENU", category: "Retail", color: palette.mint, points: [[1660, 736], [1764, 728], [1774, 895], [1662, 868]], height: 0.2, labelSize: 0.3 });
addShop({ name: "Eurokos", category: "Retail", color: palette.mint, points: [[1798, 728], [1908, 723], [1918, 892], [1812, 916], [1798, 905]], height: 0.2, labelSize: 0.3 });
addShop({ name: "Bite", category: "Retail", color: palette.cyan, points: [[1908, 723], [2014, 719], [2018, 848], [1918, 892]], height: 0.2, labelSize: 0.3 });

addShop({ name: "NewYorker", category: "Fashion", color: palette.lilac, points: [[1325, 1435], [1512, 1332], [1742, 1542], [1507, 1712], [1480, 1705]], height: 0.29, labelSize: 0.55 });
addShop({ name: "RESERVED", category: "Fashion", color: palette.rose, points: [[1548, 1412], [1778, 1290], [1768, 1260], [1904, 1182], [2042, 1264], [1983, 1404], [1738, 1540]], height: 0.31, labelSize: 0.64 });

addShop({ name: "Sinsay wing", category: "Retail", color: palette.pink, points: [[1840, 1052], [1970, 998], [1982, 1230], [1888, 1204], [1818, 1135]], height: 0.19, showLabel: false });
addShop({ name: "Sinsay", category: "Retail", color: palette.cream, points: [[1970, 998], [2100, 982], [2112, 1246], [1982, 1230]], height: 0.2, labelSize: 0.32 });
addShop({ name: "Pepco", category: "Retail", color: palette.cream, points: [[2100, 982], [2220, 966], [2227, 1245], [2112, 1246]], height: 0.2, labelSize: 0.32 });
addShop({ name: "JYSK", category: "Retail", color: palette.lilac, points: [[2220, 966], [2322, 954], [2340, 968], [2340, 1228], [2325, 1242], [2227, 1245]], height: 0.2, labelSize: 0.32 });

addShop({ name: "H&M", category: "Fashion", color: palette.pink, points: [[365, 1456], [490, 1448], [492, 1408], [730, 1405], [733, 1448], [780, 1448], [780, 1714], [365, 1722], [360, 1490]], height: 0.32, labelSize: 0.78 });
addShop({ name: "House", category: "Fashion", color: palette.blue, points: [[835, 1392], [966, 1392], [968, 1692], [840, 1688]], height: 0.2, labelSize: 0.28 });
addShop({ name: "Cropp", category: "Fashion", color: palette.blue, points: [[966, 1392], [1080, 1392], [1082, 1690], [968, 1692]], height: 0.2, labelSize: 0.28 });
addShop({ name: "Reserved Kids", category: "Fashion", color: palette.cyan, points: [[1080, 1392], [1196, 1390], [1198, 1695], [1082, 1690]], height: 0.2, labelSize: 0.27 });
addShop({ name: "Baby City", category: "Fashion", color: palette.cyan, points: [[1196, 1390], [1260, 1390], [1278, 1495], [1262, 1708], [1198, 1695]], height: 0.2, labelSize: 0.27 });

addShop({ name: "Parking", category: "Access", color: "#f8fafc", points: [[1215, 1695], [1278, 1637], [1324, 1688], [1290, 1760], [1220, 1760]], height: 0.16, labelSize: 0.4 });

const infoDots = [
  { name: "Entrance", points: [[792, 1810], [840, 1810], [840, 1855], [792, 1855]], color: "#fee2e2" },
  { name: "Information", points: [[1470, 1230], [1520, 1230], [1520, 1280], [1470, 1280]], color: "#dbeafe" },
  { name: "Restrooms", points: [[1290, 448], [1348, 448], [1348, 505], [1290, 505]], color: "#e2e8f0" },
  { name: "Restrooms", points: [[2180, 850], [2245, 850], [2245, 915], [2180, 915]], color: "#e2e8f0" },
];
infoDots.forEach((item) => addShop({ ...item, category: "Facility", height: 0.2, labelSize: 0.24 }));

function setSelected(mesh) {
  selected = mesh;
  selectedValue.textContent = mesh ? mesh.userData.name : "None";
  shopName.textContent = mesh ? mesh.userData.name : "Europa floor plan";
  shopDescription.textContent = mesh
    ? `${mesh.userData.category} area. This is a selectable Three.js mesh generated from floor-plan coordinates.`
    : "Hover or click a shop block. Every colored tenant area is a Three.js mesh, with the original plan available as a reference layer.";
}

function markHover(mesh) {
  if (hovered === mesh) return;
  if (hovered && hovered !== selected) {
    hovered.material.emissive.setHex(0x000000);
    hovered.position.z = 0;
  }
  hovered = mesh;
  if (hovered && hovered !== selected) {
    hovered.material.emissive.setHex(0x223344);
    hovered.position.z = 0.08;
  }
}

function onPointerMove(event) {
  if (topDrag?.active) {
    const deltaY = event.clientY - topDrag.y;
    const deltaX = event.clientX - topDrag.x;
    controls.rotateUp((-deltaY / window.innerHeight) * Math.PI * 0.85);
    controls.rotateLeft((-deltaX / window.innerHeight) * Math.PI * 0.38);
    controls.update();
    topDrag.x = event.clientX;
    topDrag.y = event.clientY;
  }

  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(meshes, false)[0]?.object ?? null;
  document.body.style.cursor = hit ? "pointer" : "";
  markHover(hit);
}

function onClick() {
  if (hovered) {
    if (selected && selected !== hovered) {
      selected.material.emissive.setHex(0x000000);
      selected.position.z = 0;
    }
    selected = hovered;
    selected.material.emissive.setHex(0x334155);
    selected.position.z = 0.14;
    setSelected(selected);
  }
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function moveCamera(position, target = [0, 0, 0]) {
  camera.position.set(...position);
  controls.target.set(...target);
  controls.update();
}

function onPointerDown(event) {
  if (event.button !== 0 || !event.target.closest("#scene")) return;
  const topZone = event.clientY < window.innerHeight * 0.34;
  topDrag = topZone ? { active: true, x: event.clientX, y: event.clientY } : null;
}

function onPointerUp() {
  topDrag = null;
}

window.addEventListener("resize", resize);
window.addEventListener("pointerdown", onPointerDown, { capture: true });
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);
window.addEventListener("click", onClick);
document.querySelector("#reset").addEventListener("click", () => moveCamera([0, -4.2, 14.8]));
document.querySelector("#top").addEventListener("click", () => moveCamera([0, -0.9, 15.5]));
document.querySelector("#tilt").addEventListener("click", () => moveCamera([4.8, -9.8, 7.2]));
document.querySelector("#reference").addEventListener("change", (event) => {
  floor.visible = event.target.checked;
});

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
