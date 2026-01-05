const fs = require('fs');
const Papa = require('papaparse');
const path = require('path');

module.exports = function() {
  const csvPath = path.join(__dirname, '../../scripts/stats.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.warn("Warning: scripts/stats.csv not found.");
    return { index: [], owners: {} };
  }

  const fileContent = fs.readFileSync(csvPath, 'utf8');
  const parsed = Papa.parse(fileContent, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true
  });
  
  const data = parsed.data;

  // 1. Generate Index Stats (for owners.html)
  const stats = data
    .filter(row => row.Owner && row.Owner !== 'null')
    .reduce((acc, row) => {
      if (!acc[row.Owner]) {
        acc[row.Owner] = {
          games: 0,
          wins: 0,
          losses: 0,
          rgpf: 0,
          rgpa: 0,
          playoffs: 0,
          championships: 0,
        };
      }
      acc[row.Owner].games += row.W + row.L;
      acc[row.Owner].wins += row.W;
      acc[row.Owner].losses += row.L;
      acc[row.Owner].rgpf += row.RGPF;
      acc[row.Owner].rgpa += row.RGPA;
      acc[row.Owner].playoffs += row['PO?'] === 'Y' ? 1 : 0;
      acc[row.Owner].championships += row.Champ === 'Y' ? 1 : 0;
      return acc;
    }, {});

  const index = Object.entries(stats)
    .map(([owner, data]) => ({
      owner,
      ...data,
      winPct: data.wins / (data.wins + data.losses),
      pointsDiff: data.rgpf - data.rgpa
    }))
    .filter(stat => stat.games >= 75)
    .sort((a, b) => b.winPct - a.winPct);

  // 2. Generate Individual Owner Stats
  const owners = {};
  const distinctOwners = [...new Set(data.map(row => row.Owner))];
  
  distinctOwners.forEach(owner => {
    if (!owner) return;
    const ownerData = data
      .filter(row => row.Owner === owner)
      .sort((a, b) => b.Season - a.Season);
      
    const totals = ownerData.reduce((acc, row) => ({
      wins: acc.wins + row.W,
      losses: acc.losses + row.L,
      rgpf: acc.rgpf + row.RGPF,
      rgpa: acc.rgpa + row.RGPA,
      playoffs: acc.playoffs + (row['PO?'] === 'Y' ? 1 : 0),
      championships: acc.championships + (row.Champ === 'Y' ? 1 : 0)
    }), { wins: 0, losses: 0, rgpf: 0, rgpa: 0, playoffs: 0, championships: 0 });

    const winPct = totals.wins / (totals.wins + totals.losses);
    
    owners[owner] = {
      rows: ownerData,
      totals: {
        ...totals,
        winPct
      }
    };
  });

  return {
    index,
    owners
  };
};