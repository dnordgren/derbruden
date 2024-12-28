import fs from 'fs';
import Papa from 'papaparse';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function generateStatsTable(csvPath) {
  const fullPath = join(__dirname, csvPath);
  const fileContent = fs.readFileSync(fullPath, 'utf8');
  const parsedData = Papa.parse(fileContent, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true
  });

  const stats = parsedData.data
    .filter(row => {
      return row.Owner && row.Owner !== 'null';
    })
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
      acc[row.Owner].championships += row['Champ'] === 'Y' ? 1 : 0;
      return acc;
    }, {});

  const ownerStats = Object.entries(stats)
    .map(([owner, data]) => ({
      owner,
      ...data,
      winPct: data.wins / (data.wins + data.losses),
      pointsDiff: data.rgpf - data.rgpa
    }))
    .filter(stat => stat.games >= 75) // Filter out former owners
    .sort((a, b) => b.winPct - a.winPct);

  const tableRows = ownerStats.map(stat => `
    <tr>
      <td class="owner">${stat.owner}</td>
      <td class="number">${stat.games}</td>
      <td class="number">${stat.wins}</td>
      <td class="number">${stat.losses}</td>
      <td class="number">${stat.winPct.toFixed(3).replace('0.', '.')}</td>
      <td class="number">${stat.rgpf.toLocaleString()}</td>
      <td class="number">${stat.rgpa.toLocaleString()}</td>
      <td class="number">${stat.pointsDiff.toLocaleString()}</td>
      <td class="number">${stat.playoffs}</td>
      <td class="number">${stat.championships}</td>
    </tr>`).join('');

  return `
<table class="stats-table">
  <thead>
    <tr>
      <th>Owner</th>
      <th class="number">Games</th>
      <th class="number">W</th>
      <th class="number">L</th>
      <th class="number">Win % | ↓</th>
      <th class="number">PF</th>
      <th class="number">PA</th>
      <th class="number">PDiff</th>
      <th class="number">Playoffs</th>
      <th class="number">Championships</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
  </tbody>
</table>`;
}

const tableHtml = generateStatsTable('stats.csv');
console.log(tableHtml);
