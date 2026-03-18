export function toDisplayName(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

export function formatTopic(value) {
  return `[${value.toUpperCase()}]`;
}
