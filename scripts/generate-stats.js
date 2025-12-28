import fs from 'fs';
import Papa from 'papaparse';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function generateStatsIndex(data) {
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

  const ownerStats = Object.entries(stats)
    .map(([owner, data]) => ({
      owner,
      ...data,
      winPct: data.wins / (data.wins + data.losses),
      pointsDiff: data.rgpf - data.rgpa
    }))
    .filter(stat => stat.games >= 75)
    .sort((a, b) => b.winPct - a.winPct);

  const tableRows = ownerStats.map(stat => `<tr>
      <td class="owner"><a href="./${stat.owner.toLowerCase()}.html">${stat.owner}</a></td>
      <td class="number">${stat.games}</td>
      <td class="number">${stat.wins}</td>
      <td class="number">${stat.losses}</td>
      <td class="number">${stat.winPct.toFixed(3).replace('0.', '.')}</td>
      <td class="number">${stat.rgpf.toLocaleString()}</td>
      <td class="number">${stat.rgpa.toLocaleString()}</td>
      <td class="number">${stat.pointsDiff.toLocaleString()}</td>
      <td class="number">${stat.playoffs}</td>
      <td class="number">${stat.championships ? '🏆'.repeat(stat.championships) : ''}</td>
    </tr>`).join('\n    ');

  return `<div class="table-container"><table class="stats-table">
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
</table></div>`;
}

function generateOwnerStats(data, owner) {
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

  const tableRows = ownerData.map(row => `<tr>
      <td class="number">${row.Season}</td>
      <td class="number">${row.W}</td>
      <td class="number">${row.L}</td>
      <td class="number">${(row.W / (row.W + row.L)).toFixed(3).replace('0.', '.')}</td>
      <td class="number">${row.PORnk}</td>
      <td class="number">${row.RGRnk}</td>
      <td class="number">${row.RGPF.toLocaleString()}</td>
      <td class="number">${row.RGPA.toLocaleString()}</td>
      <td class="number">${(row.RGPF - row.RGPA).toLocaleString()}</td>
      <td class="number">${row['PO?']}</td>
      <td class="number">${row.Champ === 'Y' ? '🏆' : ''}</td>
    </tr>`).join('\n    ');

  const winPct = totals.wins / (totals.wins + totals.losses);

  return `<div class="table-container"><table class="stats-table">
  <thead>
    <tr>
      <th class="number">Season</th>
      <th class="number">W</th>
      <th class="number">L</th>
      <th class="number">Win %</th>
      <th class="number">Final Rnk</th>
      <th class="number">RG Rnk</th>
      <th class="number">PF</th>
      <th class="number">PA</th>
      <th class="number">PDiff</th>
      <th class="number">Playoffs</th>
      <th class="number">Champion</th>
    </tr>
  </thead>
  <tbody>
    ${tableRows}
    <tr class="totals-row">
      <td class="number">Totals</td>
      <td class="number">${totals.wins}</td>
      <td class="number">${totals.losses}</td>
      <td class="number">${winPct.toFixed(3).replace('0.', '.')}</td>
      <td class="number">-</td>
      <td class="number">-</td>
      <td class="number">${totals.rgpf.toLocaleString()}</td>
      <td class="number">${totals.rgpa.toLocaleString()}</td>
      <td class="number">${(totals.rgpf - totals.rgpa).toLocaleString()}</td>
      <td class="number">${totals.playoffs}</td>
      <td class="number">${totals.championships ? '🏆'.repeat(totals.championships) : ''}</td>
    </tr>
  </tbody>
</table></div>`;
}

async function main() {
  const [,, command, subcommand, param] = process.argv;
  if (command !== 'owners') {
    console.error('Invalid command');
    process.exit(1);
  }

  const csvPath = join(__dirname, 'stats.csv');
  const fileContent = fs.readFileSync(csvPath, 'utf8');
  const parsedData = Papa.parse(fileContent, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true
  }).data;

  const srcDir = join(__dirname, '../src');

  function updateFile(filename, newContent) {
    const filePath = join(srcDir, filename);
    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}`);
        return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    const regex = /<div class="table-container">[\s\S]*?<\/div>/;

    if (regex.test(content)) {
      content = content.replace(regex, newContent);
      fs.writeFileSync(filePath, content);
      console.log(`Updated ${filename}`);
    } else {
        console.warn(`Could not find table container in ${filename}`);
    }
  }

  if (subcommand === 'index') {
    const ownersIndexTable = generateStatsIndex(parsedData);
    updateFile('owners.html', ownersIndexTable);
  } else if (subcommand === 'all') {
    const owners = [...new Set(parsedData.map(row => row.Owner))];
    owners.forEach(owner => {
      if (!owner) return;
      const ownerTable = generateOwnerStats(parsedData, owner);
      updateFile(`${owner.toLowerCase()}.html`, ownerTable);
    });
  } else {
    const ownerTable = generateOwnerStats(parsedData, subcommand.toUpperCase());
    updateFile(`${subcommand.toLowerCase()}.html`, ownerTable);
  }
}

main().catch(console.error);
