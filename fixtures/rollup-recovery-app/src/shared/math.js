export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeChecksum(input) {
  return [...input].reduce((sum, character, index) => {
    return sum + character.charCodeAt(0) * (index + 17);
  }, 0);
}
