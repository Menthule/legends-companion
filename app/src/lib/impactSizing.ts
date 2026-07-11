export function impactDefaultSize(screenWidth: number, screenHeight: number) {
  return {
    width: Math.round(Math.max(720, Math.min(1200, screenWidth * 0.5))),
    height: Math.round(Math.max(420, Math.min(720, screenHeight * 0.5))),
  };
}
