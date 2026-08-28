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

  const tableRows = ownerStats.map(stat => {
    const champ = stat.championships
      ? `<span class="trophies" aria-hidden="true">${'★'.repeat(stat.championships)}</span><span class="visually-hidden">${stat.championships} championship${stat.championships > 1 ? 's' : ''}</span>`
      : '<span class="visually-hidden">0</span>';
    return `<tr>
      <td class="owner"><a href="./${stat.owner.toLowerCase()}.html">${stat.owner}</a></td>
      <td class="number">${stat.games}</td>
      <td class="number">${stat.wins}</td>
      <td class="number">${stat.losses}</td>
      <td class="number">${stat.winPct.toFixed(3).replace('0.', '.')}</td>
      <td class="number">${stat.rgpf.toLocaleString()}</td>
      <td class="number">${stat.rgpa.toLocaleString()}</td>
      <td class="number">${stat.pointsDiff.toLocaleString()}</td>
      <td class="number">${stat.playoffs}</td>
      <td class="number">${champ}</td>
    </tr>`;
  }).join('\n    ');

  return `<div class="table-container"><table class="stats-table">
  <caption class="visually-hidden">League totals, all owners</caption>
  <thead>
    <tr>
      <th scope="col">Owner</th>
      <th scope="col" class="number">Games</th>
      <th scope="col" class="number">W</th>
      <th scope="col" class="number">L</th>
      <th scope="col" class="number">Win % | ↓</th>
      <th scope="col" class="number">PF</th>
      <th scope="col" class="number">PA</th>
      <th scope="col" class="number">PDiff</th>
      <th scope="col" class="number">Playoffs</th>
      <th scope="col" class="number">Championships</th>
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

  const tableRows = ownerData.map(row => {
    const champ = row.Champ === 'Y'
      ? '<span class="trophies" aria-hidden="true">★</span><span class="visually-hidden">1 championship</span>'
      : '<span class="visually-hidden">0</span>';
    return `<tr>
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
      <td class="number">${champ}</td>
    </tr>`;
  }).join('\n    ');

  const winPct = totals.wins / (totals.wins + totals.losses);
  const totalChamp = totals.championships
    ? `<span class="trophies" aria-hidden="true">${'★'.repeat(totals.championships)}</span><span class="visually-hidden">${totals.championships} championship${totals.championships > 1 ? 's' : ''}</span>`
    : '<span class="visually-hidden">0</span>';

  return `<div class="table-container"><table class="stats-table">
  <caption class="visually-hidden">Season-by-season record, ${owner}</caption>
  <thead>
    <tr>
      <th scope="col" class="number">Season</th>
      <th scope="col" class="number">W</th>
      <th scope="col" class="number">L</th>
      <th scope="col" class="number">Win %</th>
      <th scope="col" class="number">Final Rnk</th>
      <th scope="col" class="number">RG Rnk</th>
      <th scope="col" class="number">PF</th>
      <th scope="col" class="number">PA</th>
      <th scope="col" class="number">PDiff</th>
      <th scope="col" class="number">Playoffs</th>
      <th scope="col" class="number">Champion</th>
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
      <td class="number">${totalChamp}</td>
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
