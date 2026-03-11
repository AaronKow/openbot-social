function bar(value, max = 100) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div style="height:7px;background:#1a2842;border-radius:8px;overflow:hidden"><div style="height:100%;width:${percent.toFixed(1)}%;background:linear-gradient(90deg,#4cd3c2,#ffd166)"></div></div>`;
}

export function renderShell({ root, title, subtitle, nextHref, mappingNote }) {
  root.innerHTML = `
    <div class="page">
      <header class="header">
        <div>
          <h1 class="title">${title}</h1>
          <p class="subtitle">${subtitle}</p>
        </div>
        <div>
          <a href="./index.html"><button>Back to launcher</button></a>
        </div>
      </header>

      <div id="network-guard-warning" class="warning" hidden></div>

      <section class="grid">
        <div class="card">
          <div class="world-stage">
            <div id="world-3d" class="canvas" aria-label="Offline 3D world"></div>
            <button id="world-fullscreen-toggle" class="world-fullscreen-btn" type="button">Fullscreen World</button>
          </div>
          <div id="world-kv" class="kv" style="margin-top:8px"></div>
          <div class="controls" id="action-controls"></div>
        </div>

        <div class="card">
          <h3 style="margin-top:0">Observer Feed</h3>
          <div id="event-log" class="panel-scroll"></div>
          <h3>Scoreboard</h3>
          <div id="scoreboard" class="panel-scroll"></div>
          <div class="note">${mappingNote}</div>
          <div class="footer-nav">
            ${nextHref ? `<a href="${nextHref}"><button>Next Module</button></a>` : ''}
            <a href="./index.html"><button>Launcher</button></a>
          </div>
        </div>
      </section>

      <section class="card" style="margin-top:12px">
        <h3 style="margin-top:0">Lobster State</h3>
        <div style="overflow:auto">
          <table class="list" id="lobster-table"></table>
        </div>
      </section>
    </div>
  `;

  const controls = document.getElementById('action-controls');
  controls.innerHTML = `
    <button data-action="move">Move</button>
    <button data-action="idle">Idle</button>
    <button data-action="emote">Emote</button>
    <button data-action="jump">Jump</button>
    <button data-action="patrol">Patrol</button>
    <button data-action="forage">Forage</button>
    <button data-action="harvest">Harvest</button>
    <button data-action="skill:scout">Skill</button>
    <button data-action="buildRoad">Build Road</button>
    <button data-action="expandMap">Expand Map</button>
    <button data-action="buildShelter">Build Shelter</button>
    <button data-action="attack">Attack</button>
    <button data-action="defend">Defend</button>
    <button data-action="retreat">Retreat</button>
    <button data-action="rescue">Rescue</button>
    <button id="pause-toggle">Pause</button>
    <label>Speed
      <select id="sim-speed">
        <option value="0.25">0.25x</option>
        <option value="0.5">0.5x</option>
        <option value="1" selected>1x</option>
        <option value="2">2x</option>
        <option value="4">4x</option>
        <option value="8">8x</option>
      </select>
    </label>
    <label>Seed <input id="seed-input" size="14" /></label>
    <button id="save-seed">Save Seed</button>
    <button id="reset-local">Reset Local State</button>
  `;

  return {
    worldStage: document.querySelector('.world-stage'),
    worldMount: document.getElementById('world-3d'),
    worldKv: document.getElementById('world-kv'),
    eventLog: document.getElementById('event-log'),
    scoreboard: document.getElementById('scoreboard'),
    lobsterTable: document.getElementById('lobster-table'),
    controls,
    speedSelect: document.getElementById('sim-speed'),
    fullscreenToggleBtn: document.getElementById('world-fullscreen-toggle')
  };
}

export function renderSnapshot(ui, snapshot) {
  const { world, events, lobsters, scoreboard } = snapshot;

  ui.worldKv.innerHTML = `
    <div><strong>Tick</strong><br>${world.tick}</div>
    <div><strong>Day</strong><br>${world.day}</div>
    <div><strong>Hour</strong><br>${world.timeHours.toFixed(1)}</div>
    <div><strong>Phase</strong><br>${world.dayPhase}</div>
    <div><strong>Map</strong><br>${world.width}x${world.height}</div>
    <div><strong>Resources</strong><br>${(world.resources || []).length}</div>
    <div><strong>Roads</strong><br>${(world.roads || []).length}</div>
    <div><strong>Shelters</strong><br>${(world.shelters || []).length}</div>
  `;

  ui.eventLog.innerHTML = events.slice(0, 40).map((event) => (
    `<div class="log-line"><strong>${event.type}</strong> · t${event.tick}<br>${event.message}</div>`
  )).join('') || '<div class="log-line">No events yet.</div>';

  const leaderboard = (scoreboard.leaderboard || []).map((row, index) => (
    `<div class="log-line">#${index + 1} ${row.name} · ${row.points} pts · rescues ${row.rescues} · wins ${row.wins} · apm ${row.actionsPerMin}</div>`
  )).join('');

  const topPoints = Object.entries(scoreboard.points || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, points]) => `<div class="log-line">${id}: ${points}</div>`)
    .join('');

  ui.scoreboard.innerHTML = leaderboard || topPoints || '<div class="log-line">No scores yet.</div>';

  ui.lobsterTable.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>State</th>
        <th>Queue</th>
        <th>Energy</th>
        <th>Inventory</th>
        <th>Shelter</th>
        <th>Scout</th>
        <th>Builder</th>
      </tr>
    </thead>
    <tbody>
      ${lobsters.map((lobster) => {
        const scout = lobster.skills?.scout || { level: 1, cooldown: 0 };
        const builder = lobster.skills?.builder || { level: 1, cooldown: 0 };
        const inventory = lobster.inventory || { rock: 0, kelp: 0, seaweed: 0 };
        const shelter = (world.shelters || []).find((entry) => entry.ownerId === lobster.id);
        const shelterHp = shelter ? `${Math.max(0, Number(shelter.hp || 0)).toFixed(0)}/${Math.max(1, Number(shelter.maxHp || 1)).toFixed(0)}` : 'none';
        const rebuildCd = Number(lobster.shelterState?.rebuildCooldown || 0).toFixed(1);
        return `
          <tr>
            <td>${lobster.name}</td>
            <td>${lobster.state}</td>
            <td>${lobster.actionQueue.length}</td>
            <td>${bar(lobster.stats.energy)} ${lobster.stats.energy.toFixed(1)}</td>
            <td>R ${inventory.rock || 0} · K ${inventory.kelp || 0} · S ${inventory.seaweed || 0}</td>
            <td>${shelterHp} · cd ${rebuildCd}s</td>
            <td>L${scout.level} · cd ${Number(scout.cooldown).toFixed(1)}</td>
            <td>L${builder.level} · cd ${Number(builder.cooldown).toFixed(1)}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}
