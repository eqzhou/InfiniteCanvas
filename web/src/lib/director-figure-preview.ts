import type { DirectorCharacterPreset, DirectorPosePreset, DirectorVector3 } from "@/types/board";
import { getDirectorCharacterPreset, getDirectorPosePreset } from "@/lib/director-cast";

export type DirectorPreviewPoint = { x: number; y: number };

export type DirectorFigurePreview = {
  color: string;
  skinColor: string;
  accessory: "none" | "jacket" | "belt" | "visor";
  strokeWidth: number;
  head: DirectorPreviewPoint & { radius: number };
  torso: DirectorPreviewPoint & { width: number; height: number; rotation: number };
  limbs: Array<{
    id: "left-arm" | "right-arm" | "left-leg" | "right-leg";
    start: DirectorPreviewPoint;
    end: DirectorPreviewPoint;
    width: number;
  }>;
};

const radians = (degrees: number): number => degrees * Math.PI / 180;

function projectedAngle(rotation: DirectorVector3, side: -1 | 1): number {
  return rotation.z + side * rotation.x * 0.62 + rotation.y * 0.14;
}

function endpoint(start: DirectorPreviewPoint, length: number, angle: number): DirectorPreviewPoint {
  const value = radians(angle);
  return {
    x: start.x + Math.sin(value) * length,
    y: start.y + Math.cos(value) * length,
  };
}

export function buildDirectorFigurePreview(
  characterId: DirectorCharacterPreset,
  poseId: DirectorPosePreset,
): DirectorFigurePreview {
  const character = getDirectorCharacterPreset(characterId);
  const pose = getDirectorPosePreset(poseId);
  const body = character.bodyScale;
  const hip = { x: 40, y: 58 + (pose.rootY ?? 0) * 18 };
  const torsoHeight = 25 * body.y;
  const torsoAngle = projectedAngle(pose.joints.torso, 1);
  const torsoTop = endpoint(hip, -torsoHeight, torsoAngle);
  const torsoCenter = {
    x: (hip.x + torsoTop.x) / 2,
    y: (hip.y + torsoTop.y) / 2,
  };
  const shoulderOffset = 7.5 * body.x * character.shoulderWidth;
  const hipOffset = 4.6 * body.x;
  const shoulderY = torsoTop.y + 4;
  const headAngle = projectedAngle(pose.joints.head, 1);
  const headRadius = 6.2 * character.headScale;
  const head = {
    x: torsoTop.x + Math.sin(radians(headAngle)) * 2.4,
    y: torsoTop.y - headRadius - 2 + Math.cos(radians(headAngle)) * 0.8,
    radius: headRadius,
  };
  const armLength = 23 * character.limbScale * body.y;
  const legLength = 27 * character.limbScale * body.y;
  const limbWidth = 4.8 * body.x;
  const leftShoulder = { x: torsoTop.x - shoulderOffset, y: shoulderY };
  const rightShoulder = { x: torsoTop.x + shoulderOffset, y: shoulderY };
  const leftHip = { x: hip.x - hipOffset, y: hip.y - 1 };
  const rightHip = { x: hip.x + hipOffset, y: hip.y - 1 };

  return {
    color: character.outfitColor,
    skinColor: character.skinColor,
    accessory: character.accessory,
    strokeWidth: limbWidth,
    head,
    torso: {
      ...torsoCenter,
      width: shoulderOffset * 1.7,
      height: torsoHeight,
      rotation: torsoAngle,
    },
    limbs: [
      { id: "left-arm", start: leftShoulder, end: endpoint(leftShoulder, armLength, projectedAngle(pose.joints.leftArm, -1)), width: limbWidth },
      { id: "right-arm", start: rightShoulder, end: endpoint(rightShoulder, armLength, projectedAngle(pose.joints.rightArm, 1)), width: limbWidth },
      { id: "left-leg", start: leftHip, end: endpoint(leftHip, legLength, projectedAngle(pose.joints.leftLeg, -1)), width: limbWidth * 1.08 },
      { id: "right-leg", start: rightHip, end: endpoint(rightHip, legLength, projectedAngle(pose.joints.rightLeg, 1)), width: limbWidth * 1.08 },
    ],
  };
}
