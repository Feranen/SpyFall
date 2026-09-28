// presets.js - Word-pack presets.

// ===== presets =====

// --- PRESET SCANNER & LOCAL STORAGE MANAGEMENT ---

// Retrieve all presets currently saved in localStorage
function getStoredPresets() {
    try {
        return JSON.parse(localStorage.getItem('spyfall_presets')) || {};
    } catch (e) {
        return {};
    }
}

// Save unified preset dictionary to localStorage and update UI
function savePresetsToStorage(presets) {
    localStorage.setItem('spyfall_presets', JSON.stringify(presets));
    populatePresetDropdown();
    renderSavedPresetsList();
}

const DEFAULT_PRESET_FILES = [
    'dota2_heroes.json',
    'dota2_items.json'
];

// Scans 'preset/' folder, fetches preset JSON files, and updates localStorage
async function scanAndSyncPresets() {
    const existingPresets = getStoredPresets();
    const discoveredFiles = new Set();

    // Strategy 1: Attempt to fetch preset/manifest.json
    try {
        const manifestRes = await fetch('preset/manifest.json');
        if (manifestRes.ok) {
            const manifestList = await manifestRes.json();
            if (Array.isArray(manifestList)) {
                manifestList.forEach(file => discoveredFiles.add(file));
            }
        }
    } catch (e) {
        // Manifest missing or unreadable; proceed to fallbacks
    }

    // Strategy 2: Attempt HTML directory scraping (works on Apache/Nginx AutoIndex)
    if (discoveredFiles.size === 0) {
        try {
            const response = await fetch('preset/');
            if (response.ok) {
                const htmlText = await response.text();
                const regex = /href=["']?([^"'>]+\.json)["']?/gi;
                let match;

                while ((match = regex.exec(htmlText)) !== null) {
                    let filename = match[1].split('/').pop();
                    if (filename && filename.toLowerCase().endsWith('.json') && filename !== 'manifest.json') {
                        discoveredFiles.add(filename);
                    }
                }
            }
        } catch (err) {
            console.warn("Directory index scanning unavailable.", err);
        }
    }

    // Strategy 3: Fallback to predefined filename list if no index/manifest found
    if (discoveredFiles.size === 0) {
        DEFAULT_PRESET_FILES.forEach(file => discoveredFiles.add(file));
    }

    // Fetch each discovered preset JSON file and sync to localStorage
    for (const file of discoveredFiles) {
        try {
            const path = file.startsWith('preset/') ? file : `preset/${file}`;
            const fileRes = await fetch(path);
            if (fileRes.ok) {
                const presetData = await fileRes.json();
                const presetName = presetData.name || file.replace('.json', '');

                existingPresets[presetName] = {
                    name: presetName,
                    source: 'preset_folder',
                    items: presetData.items || [],
                    facts: presetData.facts || {}
                };
            }
        } catch (e) {
            console.warn(`Could not load preset file ${file}:`, e);
        }
    }

    savePresetsToStorage(existingPresets);
    populatePresetDropdown();
}

// --- PRESET UI ACTIONS ---

function populatePresetDropdown() {
    const select = document.getElementById('preset-select');
    if (!select) return;
    const selectedVal = select.value;
    select.innerHTML = '';

    const presets = getStoredPresets();
    const keys = Object.keys(presets);

    if (keys.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.innerText = '-- No Presets Found --';
        select.appendChild(opt);
        return;
    }

    const folderGroup = document.createElement('optgroup');
    folderGroup.label = "Folder Presets (preset/)";

    const customGroup = document.createElement('optgroup');
    customGroup.label = "Custom / Saved Presets";

    keys.forEach(key => {
        const preset = presets[key];
        const opt = document.createElement('option');
        opt.value = key;
        opt.innerText = `${preset.source === 'custom' ? '⭐ ' : ''}${preset.name} (${preset.items ? preset.items.length : 0} items)`;

        if (preset.source === 'preset_folder') {
            folderGroup.appendChild(opt);
        } else {
            customGroup.appendChild(opt);
        }
    });

    if (folderGroup.children.length > 0) select.appendChild(folderGroup);
    if (customGroup.children.length > 0) select.appendChild(customGroup);

    if (selectedVal && select.querySelector(`option[value="${CSS.escape(selectedVal)}"]`)) {
        select.value = selectedVal;
    }
}

function openPresetModal() {
    renderSavedPresetsList();
    openModal('preset-modal');
}

function renderSavedPresetsList() {
    const container = document.getElementById('saved-preset-list');
    if (!container) return;
    container.innerHTML = '';
    const presets = getStoredPresets();
    const keys = Object.keys(presets);

    if (keys.length === 0) {
        container.innerHTML = '<div style="color:var(--text-dim); padding:6px; font-size:0.8rem;">No saved presets available.</div>';
        return;
    }

    keys.forEach(key => {
        const preset = presets[key];
        const div = document.createElement('div');
        div.className = 'preset-manage-item';
        div.innerHTML = `
            <span><strong>${preset.name}</strong> (${preset.items ? preset.items.length : 0} items) ${preset.source === 'preset_folder' ? '<small>[folder]</small>' : ''}</span>
            <div>
                <button class="sm-btn btn-blue" onclick="exportPresetByName('${preset.name}')">Export</button>
                ${preset.source !== 'preset_folder' ? `<button class="sm-btn" style="background:var(--accent-red); color:#fff;" onclick="deleteCustomPreset('${preset.name}')">Delete</button>` : ''}
            </div>
        `;
        container.appendChild(div);
    });
}

function saveCustomPresetForm() {
    const nameInput = document.getElementById('new-preset-name').value.trim();
    const rawText = document.getElementById('new-preset-items').value.trim();

    if (!nameInput) { alert("Please enter a Preset Name!"); return; }
    if (!rawText) { alert("Please enter items!"); return; }

    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const items = [];
    const facts = {};

    lines.forEach(line => {
        if (line.includes('|')) {
            const parts = line.split('|');
            const item = parts[0].trim();
            const fact = parts.slice(1).join('|').trim();
            if (item) {
                items.push(item);
                facts[item] = fact;
            }
        } else {
            items.push(line);
        }
    });

    if (items.length < 3) {
        alert("Preset must have at least 3 items!");
        return;
    }

    const presets = getStoredPresets();
    presets[nameInput] = {
        name: nameInput,
        source: 'custom',
        items: items,
        facts: facts
    };

    savePresetsToStorage(presets);

    document.getElementById('new-preset-name').value = '';
    document.getElementById('new-preset-items').value = '';
    document.getElementById('preset-select').value = nameInput;
    alert(`Preset "${nameInput}" saved successfully to localStorage!`);
}

function deleteCustomPreset(name) {
    if (!confirm(`Delete custom preset "${name}" from localStorage?`)) return;
    const presets = getStoredPresets();
    delete presets[name];
    savePresetsToStorage(presets);
}

function exportPresetByName(name) {
    const presets = getStoredPresets();
    if (presets[name]) {
        downloadJsonFile(`${name}_preset.json`, { name: presets[name].name, items: presets[name].items, facts: presets[name].facts || {} });
    }
}

function exportSelectedPreset() {
    const key = document.getElementById('preset-select').value;
    const presets = getStoredPresets();
    if (presets[key]) {
        downloadJsonFile(`${presets[key].name.toLowerCase().replace(/[^a-z0-9]/gi, '_')}.json`, presets[key]);
    } else {
        alert("Select a valid preset to export.");
    }
}

function triggerImportFile() {
    const input = document.getElementById('preset-file-input');
    if (input) input.click();
}

function importPresetFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            if (!json.name || !Array.isArray(json.items) || json.items.length < 3) {
                throw new Error("Invalid preset format.");
            }
            const presets = getStoredPresets();
            presets[json.name] = {
                name: json.name,
                source: 'custom',
                items: json.items,
                facts: json.facts || {}
            };
            savePresetsToStorage(presets);
            document.getElementById('preset-select').value = json.name;
            alert(`Successfully imported preset "${json.name}"!`);
        } catch (err) {
            alert("Failed to import JSON file: " + err.message);
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}
