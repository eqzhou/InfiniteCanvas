import type {
  DirectorCharacterConfig,
  DirectorCharacterPreset,
  DirectorCrowdConfig,
  DirectorPosePreset,
  DirectorPrimitive,
  DirectorVector3,
} from "@/types/board";

export type DirectorCharacterPresetDefinition = {
  id: DirectorCharacterPreset;
  label: string;
  outfitColor: string;
  skinColor: string;
  bodyScale: DirectorVector3;
  headScale: number;
  shoulderWidth: number;
  limbScale: number;
  accessory: "none" | "jacket" | "belt" | "visor";
};

export type DirectorPoseDefinition = {
  id: DirectorPosePreset;
  label: string;
  joints: {
    torso: DirectorVector3;
    head: DirectorVector3;
    leftArm: DirectorVector3;
    rightArm: DirectorVector3;
    leftLeg: DirectorVector3;
    rightLeg: DirectorVector3;
  };
  rootY?: number;
};

const v = (x = 0, y = 0, z = 0): DirectorVector3 => ({ x, y, z });

export const DIRECTOR_CHARACTER_PRESETS: readonly DirectorCharacterPresetDefinition[] = [
  { id: "studio", label: "棚拍标准", outfitColor: "#64748b", skinColor: "#d8a47f", bodyScale: v(1, 1, 1), headScale: 1, shoulderWidth: 1, limbScale: 1, accessory: "none" },
  { id: "tall", label: "修长轮廓", outfitColor: "#475569", skinColor: "#b97855", bodyScale: v(0.9, 1.16, 0.9), headScale: 0.94, shoulderWidth: 0.92, limbScale: 1.13, accessory: "jacket" },
  { id: "compact", label: "紧凑轮廓", outfitColor: "#7c3aed", skinColor: "#e4b590", bodyScale: v(0.94, 0.88, 0.94), headScale: 1.08, shoulderWidth: 0.94, limbScale: 0.86, accessory: "belt" },
  { id: "athletic", label: "运动轮廓", outfitColor: "#0f766e", skinColor: "#9f6849", bodyScale: v(1.04, 1.04, 1), headScale: 0.98, shoulderWidth: 1.14, limbScale: 1.04, accessory: "none" },
  { id: "broad", label: "宽肩轮廓", outfitColor: "#9a3412", skinColor: "#c98b65", bodyScale: v(1.14, 1, 1.06), headScale: 1.02, shoulderWidth: 1.22, limbScale: 1.02, accessory: "jacket" },
  { id: "casual", label: "日常造型", outfitColor: "#2563eb", skinColor: "#f0c5a5", bodyScale: v(1, 0.98, 1), headScale: 1.04, shoulderWidth: 1, limbScale: 0.98, accessory: "belt" },
  { id: "formal", label: "正装造型", outfitColor: "#1e293b", skinColor: "#8d5b43", bodyScale: v(0.98, 1.06, 0.96), headScale: 0.98, shoulderWidth: 1.06, limbScale: 1.03, accessory: "jacket" },
  { id: "future", label: "未来造型", outfitColor: "#4338ca", skinColor: "#c68f6d", bodyScale: v(1, 1.03, 1), headScale: 1, shoulderWidth: 1.08, limbScale: 1.02, accessory: "visor" },
] as const;

const pose = (
  id: DirectorPosePreset,
  label: string,
  joints: Partial<DirectorPoseDefinition["joints"]>,
  rootY?: number,
): DirectorPoseDefinition => ({
  id,
  label,
  joints: {
    torso: joints.torso ?? v(),
    head: joints.head ?? v(),
    leftArm: joints.leftArm ?? v(),
    rightArm: joints.rightArm ?? v(),
    leftLeg: joints.leftLeg ?? v(),
    rightLeg: joints.rightLeg ?? v(),
  },
  rootY,
});

export const DIRECTOR_POSE_PRESETS: readonly DirectorPoseDefinition[] = [
  pose("neutral", "自然站立", {}),
  pose("contrapposto", "重心站姿", { torso: v(0, 0, -5), leftLeg: v(0, 0, 8), rightLeg: v(0, 0, -5) }),
  pose("arms-crossed", "双臂交叉", { leftArm: v(62, 8, -54), rightArm: v(62, -8, 54), head: v(0, -4, 0) }),
  pose("hands-hips", "双手叉腰", { leftArm: v(38, -20, -48), rightArm: v(38, 20, 48), torso: v(0, 0, 3) }),
  pose("wave-left", "左手挥动", { leftArm: v(-150, 0, -18), rightArm: v(8, 0, 4), head: v(0, 8, 0) }),
  pose("wave-right", "右手挥动", { leftArm: v(8, 0, -4), rightArm: v(-150, 0, 18), head: v(0, -8, 0) }),
  pose("point-left", "向左指引", { leftArm: v(0, 0, -88), rightArm: v(12, 0, 6), torso: v(0, -8, 0) }),
  pose("point-right", "向右指引", { leftArm: v(12, 0, -6), rightArm: v(0, 0, 88), torso: v(0, 8, 0) }),
  pose("walk-left", "左脚迈步", { leftArm: v(22), rightArm: v(-24), leftLeg: v(-28), rightLeg: v(22), torso: v(4) }),
  pose("walk-right", "右脚迈步", { leftArm: v(-24), rightArm: v(22), leftLeg: v(22), rightLeg: v(-28), torso: v(4) }),
  pose("run", "奔跑", { leftArm: v(-58), rightArm: v(64), leftLeg: v(56), rightLeg: v(-64), torso: v(16) }),
  pose("sit", "坐姿", { torso: v(-8), leftLeg: v(-82), rightLeg: v(-82), leftArm: v(24), rightArm: v(24) }, 0.72),
  pose("crouch", "下蹲", { torso: v(24), leftLeg: v(-54, 0, -12), rightLeg: v(-54, 0, 12), leftArm: v(-30), rightArm: v(-30) }, 0.35),
  pose("lean", "侧身倚靠", { torso: v(0, 0, -18), head: v(0, 0, 10), leftArm: v(18, 0, -32), rightLeg: v(0, 0, 12) }),
  pose("reach", "向上伸展", { leftArm: v(-168, 0, -8), rightArm: v(-162, 0, 10), head: v(-12), torso: v(-6) }),
  pose("look-back", "回头观察", { torso: v(0, 38, 0), head: v(0, 46, 0), leftArm: v(12), rightArm: v(-8) }),
  pose("guard", "防守姿态", { leftArm: v(-72, 0, -32), rightArm: v(-68, 0, 34), leftLeg: v(12, 0, -18), rightLeg: v(-10, 0, 18), torso: v(8) }),
  pose("celebrate", "欢呼", { leftArm: v(-156, 0, -26), rightArm: v(-156, 0, 26), head: v(-10), torso: v(-4) }),
  pose("talk", "交谈手势", { leftArm: v(-48, 0, -36), rightArm: v(18, 0, 16), head: v(0, -10, 0), torso: v(0, 8, 0) }),
  pose("camera-ready", "镜头定姿", { leftArm: v(18, 0, -12), rightArm: v(32, 0, 24), leftLeg: v(0, 0, -8), rightLeg: v(0, 0, 6), head: v(0, 4, 0), torso: v(0, -4, 0) }),
] as const;

export const DIRECTOR_PRIMITIVES: readonly { id: DirectorPrimitive; label: string }[] = [
  { id: "box", label: "立方体" },
  { id: "sphere", label: "球体" },
  { id: "cylinder", label: "圆柱体" },
  { id: "cone", label: "圆锥体" },
  { id: "torus", label: "圆环" },
  { id: "plane", label: "平面" },
] as const;

const characterIds = new Set(DIRECTOR_CHARACTER_PRESETS.map(({ id }) => id));
const poseIds = new Set(DIRECTOR_POSE_PRESETS.map(({ id }) => id));
const primitiveIds = new Set(DIRECTOR_PRIMITIVES.map(({ id }) => id));
const CROWD_VARIATION_POSES: readonly DirectorPosePreset[] = [
  "neutral",
  "walk-left",
  "walk-right",
  "talk",
  "camera-ready",
];

export const isDirectorCharacterPreset = (value: unknown): value is DirectorCharacterPreset =>
  typeof value === "string" && characterIds.has(value as DirectorCharacterPreset);
export const isDirectorPosePreset = (value: unknown): value is DirectorPosePreset =>
  typeof value === "string" && poseIds.has(value as DirectorPosePreset);
export const isDirectorPrimitive = (value: unknown): value is DirectorPrimitive =>
  typeof value === "string" && primitiveIds.has(value as DirectorPrimitive);

export function getDirectorCharacterPreset(id: DirectorCharacterPreset): DirectorCharacterPresetDefinition {
  return DIRECTOR_CHARACTER_PRESETS.find((item) => item.id === id)!;
}

export function getDirectorPosePreset(id: DirectorPosePreset): DirectorPoseDefinition {
  return DIRECTOR_POSE_PRESETS.find((item) => item.id === id)!;
}

export type DirectorCrowdPlacement = {
  x: number;
  z: number;
  rotationY: number;
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
};

export function buildDirectorCrowdPlacements(config: DirectorCrowdConfig): DirectorCrowdPlacement[] {
  const placements: DirectorCrowdPlacement[] = [];
  const centerX = (config.columns - 1) / 2;
  const centerZ = (config.rows - 1) / 2;
  for (let row = 0; row < config.rows; row += 1) {
    for (let column = 0; column < config.columns; column += 1) {
      const index = row * config.columns + column;
      const hash = (Math.imul(config.seed ^ 0x9e3779b9, 1664525) + Math.imul(index + 1, 1013904223)) >>> 0;
      const useBaseLook = !config.variation || (hash & 3) === 0;
      placements.push({
        x: (column - centerX) * config.spacingX,
        z: (row - centerZ) * config.spacingZ,
        rotationY: config.variation ? (hash % 17) - 8 : 0,
        preset: !useBaseLook
          ? DIRECTOR_CHARACTER_PRESETS[(hash >>> 4) % DIRECTOR_CHARACTER_PRESETS.length]!.id
          : config.preset,
        pose: !useBaseLook
          ? CROWD_VARIATION_POSES[(hash >>> 9) % CROWD_VARIATION_POSES.length]!
          : config.pose,
      });
    }
  }
  return placements;
}

export const DEFAULT_CHARACTER_CONFIG: DirectorCharacterConfig = {
  preset: "studio",
  pose: "neutral",
  role: "actor",
};

export const DEFAULT_CROWD_CONFIG: DirectorCrowdConfig = {
  preset: "casual",
  pose: "neutral",
  rows: 3,
  columns: 3,
  spacingX: 1.35,
  spacingZ: 1.35,
  variation: true,
  seed: 1,
};
