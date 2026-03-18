import { greetVisitor } from './lib/greet.js';
import { rememberVisit, getVisitCount, listRecentVisitors } from './lib/state.js';
import { clamp, computeChecksum } from './shared/math.js';
import { formatTopic } from './shared/format.js';

const siteConfig = {
  title: 'Fixture Site',
  maxVisits: 7,
};

export function boot(name) {
  rememberVisit(name);
  const visitCount = clamp(getVisitCount(), 0, siteConfig.maxVisits);
  const header = formatTopic(siteConfig.title);
  const greeting = greetVisitor(name, visitCount);
  const checksum = computeChecksum(`${name}:${visitCount}`);

  return `${header} :: ${greeting} :: checksum=${checksum}`;
}

export async function loadLazyPanel(name) {
  const lazyModule = await import('./lazy.js');

  return lazyModule.renderLazyPanel({
    name,
    visitCount: getVisitCount(),
    recentVisitors: listRecentVisitors(),
  });
}

const currentVisitor = 'Ada Lovelace';

console.log(boot(currentVisitor));
void loadLazyPanel(currentVisitor).then((panel) => {
  console.log(panel);
});
