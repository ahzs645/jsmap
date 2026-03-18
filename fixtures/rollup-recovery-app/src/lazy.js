import { formatTopic, toDisplayName } from './shared/format.js';
import { clamp, computeChecksum } from './shared/math.js';

class LazyPanelModel {
  constructor({ name, visitCount, recentVisitors }) {
    this.name = toDisplayName(name);
    this.visitCount = clamp(visitCount, 0, 9);
    this.recentVisitors = recentVisitors;
  }

  render() {
    const summary = this.recentVisitors.join(' | ');
    const checksum = computeChecksum(summary || this.name);

    return `${formatTopic('Lazy Panel')} -> ${this.name} (${this.visitCount}) [${checksum}]`;
  }
}

export function renderLazyPanel(payload) {
  const panel = new LazyPanelModel(payload);
  return `${panel.render()} :: recent=${panel.recentVisitors.length}`;
}
