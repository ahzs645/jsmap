const recentVisitors = [];

export function rememberVisit(name) {
  recentVisitors.push(name.trim());

  if (recentVisitors.length > 4) {
    recentVisitors.shift();
  }
}

export function getVisitCount() {
  return recentVisitors.length;
}

export function listRecentVisitors() {
  return [...recentVisitors];
}
