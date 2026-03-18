import { formatTopic, toDisplayName } from '../shared/format.js';

function pluralizeVisits(count) {
  return count === 1 ? 'visit' : 'visits';
}

export function greetVisitor(name, visitCount) {
  const displayName = toDisplayName(name);
  const label = formatTopic('Welcome');

  return `${label} ${displayName}, you have ${visitCount} ${pluralizeVisits(visitCount)}.`;
}
