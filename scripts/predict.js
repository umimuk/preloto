#!/usr/bin/env node
/**
 * scripts/predict.js
 * GitHub Actions から定期実行して data/history.json を更新するスクリプト。
 * Node.js 18+ の組み込み fetch を使用。
 *
 * Usage: node scripts/predict.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SHEET_ID    = '1y_8fEZpj7rvJdx3AOMSxjxLsNh_zso2d_b1EVEZWNB4';
const HISTORY_PATH = path.join(__dirname, '../data/history.json');

// ------------------------------------------------------------------ //
//  CSV 取得・パース
// ------------------------------------------------------------------ //

async function fetchSheetData() {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Spreadsheet fetch failed: ${res.status}`);
    return parseCSV(await res.text());
}

function parseCSV(csv) {
    const data  = [];
    const lines = csv.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const line  = lines[i].replace(/"/g, '').trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length < 9) continue;
        const roundNum = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
        if (isNaN(roundNum)) continue;
        const nums = [
            parseInt(parts[2], 10), parseInt(parts[3], 10),
            parseInt(parts[4], 10), parseInt(parts[5], 10),
            parseInt(parts[6], 10), parseInt(parts[7], 10),
            parseInt(parts[8], 10),
        ];
        // ⑥ ボーナス数字（Loto7は2個: parts[9], parts[10]）
        const bonus = [];
        if (parts.length > 9)  { const b = parseInt(parts[9],  10); if (!isNaN(b) && b >= 1 && b <= 37) bonus.push(b); }
        if (parts.length > 10) { const b = parseInt(parts[10], 10); if (!isNaN(b) && b >= 1 && b <= 37) bonus.push(b); }
        data.push({ round: roundNum, date: parts[1], numbers: nums, bonus });
    }
    data.sort((a, b) => b.round - a.round);
    return data;
}

// ------------------------------------------------------------------ //
//  予想アルゴリズム（新D条件）
// ------------------------------------------------------------------ //

function analyzeData(historyData) {
    const counts       = new Array(38).fill(0);
    const last10Counts = new Array(38).fill(0);
    const bonusCounts  = new Array(38).fill(0);  // ⑥ ボーナス数字出現回数
    const lastSeen     = new Array(38).fill(-1);
    const pairs        = {};

    historyData.forEach((drawObj, index) => {
        const draw = drawObj.numbers;
        draw.forEach(num => {
            counts[num]++;
            if (index < 10) last10Counts[num]++;
            if (lastSeen[num] === -1) lastSeen[num] = index;
        });
        // ⑥ ボーナス数字集計
        if (drawObj.bonus) {
            drawObj.bonus.forEach(b => { if (b >= 1 && b <= 37) bonusCounts[b]++; });
        }
        for (let i = 0; i < draw.length; i++) {
            for (let j = i + 1; j < draw.length; j++) {
                const p = `${draw[i]}-${draw[j]}`;
                pairs[p] = (pairs[p] || 0) + 1;
            }
        }
    });

    // 前回当選番号
    const prevWinning = historyData.length > 0 ? historyData[0].numbers : [];

    // ② 連番ペア: 前回当選の±1番号
    const prevNeighbors = new Set();
    prevWinning.forEach(n => {
        if (n - 1 >= 1)  prevNeighbors.add(n - 1);
        if (n + 1 <= 37) prevNeighbors.add(n + 1);
    });

    const hotNumbers  = [];
    const coldNumbers = [];
    for (let i = 1; i <= 37; i++) {
        if (last10Counts[i] >= 3) hotNumbers.push(i);
        if (last10Counts[i] === 0) coldNumbers.push(i);
    }

    // スコアリング（新D条件: ① ② ⑥）
    const scores = [];
    for (let i = 1; i <= 37; i++) {
        let score = counts[i] * 5;

        // ① 直近10回の出現頻度重み付け
        score += last10Counts[i] * 10;

        // ② 連番ペア（前回当選の±1番号をスコア加点）
        if (prevNeighbors.has(i)) score += 15;

        // ペア相性
        let maxPairCount = 0;
        let bestPartner  = 0;
        for (let j = 1; j <= 37; j++) {
            if (i === j) continue;
            const p = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (pairs[p] && pairs[p] > maxPairCount) {
                maxPairCount = pairs[p];
                bestPartner  = j;
            }
        }
        if (maxPairCount >= 15) score += maxPairCount;

        // ⑥ ボーナス数字の本数字昇格
        if (bonusCounts[i] >= 3) score += bonusCounts[i] * 3;

        scores.push({
            num: i, score,
            freq: counts[i], last10: last10Counts[i],
            maxPairCount, bestPartner,
            bonus: bonusCounts[i],
        });
    }
    scores.sort((a, b) =>
        b.score !== a.score ? b.score - a.score :
        b.freq  !== a.freq  ? b.freq  - a.freq  : a.num - b.num
    );

    // ---- 後選択バリデーション（③ ④ ⑤） ----

    // ③ 奇数偶数バランス（全偶数・全奇数を除外、3:4 or 4:3 が理想）
    const isOddEvenOk = nums => {
        const e = nums.filter(n => n % 2 === 0).length;
        return e >= 1 && e <= 6; // 全偶数(7個)・全奇数(0個)を除外
    };
    // ④ 10の位の分布バランス（末尾同一3個以上NG）
    const isTailOk = nums => {
        const t = {};
        for (const n of nums) {
            t[n % 10] = (t[n % 10] || 0) + 1;
            if (t[n % 10] >= 3) return false;
        }
        return true;
    };
    // ⑤ 前回当選番号の除外（完全一致3個以上被り制限）
    const isPrevOk = nums =>
        nums.filter(n => prevWinning.includes(n)).length < 3;

    function applyConstraints(initial) {
        const nums = initial.map(s => s.num);
        if (isOddEvenOk(nums) && isTailOk(nums) && isPrevOk(nums)) return initial;

        const usedSet   = new Set(nums);
        const remaining = scores.filter(s => !usedSet.has(s.num));

        for (let i = initial.length - 1; i >= 0; i--) {
            for (const cand of remaining) {
                const candidate = nums.map((v, idx) => idx === i ? cand.num : v);
                if (isOddEvenOk(candidate) && isTailOk(candidate) && isPrevOk(candidate)) {
                    const result = [...initial];
                    result[i] = cand;
                    return result.sort((a, b) => a.num - b.num);
                }
            }
        }
        return initial; // バリデーション通過できない場合はそのまま返す
    }

    // ---- パターン A「王道」: スコア上位7個 ----
    const patternA = applyConstraints(scores.slice(0, 7).sort((a, b) => a.num - b.num));

    // ---- パターン B「逆張り」: 冷え番号優先 ----
    const coldPool = scores.filter(s => s.last10 <= 1);
    const warmPool = scores.filter(s => s.last10 > 1);
    const bBase    = [...coldPool.slice(0, 5), ...warmPool.slice(0, 2)].slice(0, 7).sort((a, b) => a.num - b.num);
    const patternB = applyConstraints(bBase);

    // ---- パターン C「バランス」: 熱3 + 冷2 + ペア2 ----
    const hotPool    = scores.filter(s => hotNumbers.includes(s.num));
    const coldPool2  = scores.filter(s => coldNumbers.includes(s.num));
    const pairSorted = [...scores].sort((a, b) => b.maxPairCount - a.maxPairCount);

    const c_hot  = hotPool.slice(0, 3);
    const usedC  = new Set(c_hot.map(s => s.num));
    const c_cold = coldPool2.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_cold.forEach(s => usedC.add(s.num));
    const c_pair = pairSorted.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_pair.forEach(s => usedC.add(s.num));
    let cBase = [...c_hot, ...c_cold, ...c_pair];
    if (cBase.length < 7) {
        const fill = scores.filter(s => !usedC.has(s.num)).slice(0, 7 - cBase.length);
        cBase = [...cBase, ...fill];
    }
    const patternC = applyConstraints(cBase.sort((a, b) => a.num - b.num));

    return { patternA, patternB, patternC, hotNumbers, coldNumbers, scores };
}

// ------------------------------------------------------------------ //
//  照合
// ------------------------------------------------------------------ //

function countMatches(pattern, result) {
    return pattern.filter(n => result.includes(n)).length;
}

// ------------------------------------------------------------------ //
//  ユーティリティ
// ------------------------------------------------------------------ //

function getRoundNum(roundLabel) {
    return parseInt(roundLabel.replace(/[^0-9]/g, ''), 10);
}

// ------------------------------------------------------------------ //
//  history.json 読み書き
// ------------------------------------------------------------------ //

function loadHistory() {
    try {
        const dir = path.dirname(HISTORY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(HISTORY_PATH)) return [];
        return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    } catch {
        return [];
    }
}

function saveHistory(data) {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log(`history.json saved: ${data.length} entries`);
}

// ------------------------------------------------------------------ //
//  backfill: history.json が10件未満の場合に過去分を遡って補完
// ------------------------------------------------------------------ //

async function backfill(sheetData, stored) {
    console.log('Running backfill...');
    const target     = sheetData.slice(0, 10); // 最新10回分が対象
    const newEntries = [];

    for (const draw of target) {
        if (stored.some(e => getRoundNum(e.round) === draw.round)) continue;
        // その回より前のデータで予想を再計算
        const prevData = sheetData.filter(h => h.round < draw.round);
        if (prevData.length < 5) continue; // データが少なすぎる場合はスキップ

        const analysis = analyzeData(prevData);
        const pA = analysis.patternA.map(s => s.num);
        const pB = analysis.patternB.map(s => s.num);
        const pC = analysis.patternC.map(s => s.num);

        newEntries.push({
            round:       `第${draw.round}回`,
            date:        draw.date,
            predictions: { patternA: pA, patternB: pB, patternC: pC },
            result:      draw.numbers,
            matchA:      countMatches(pA, draw.numbers),
            matchB:      countMatches(pB, draw.numbers),
            matchC:      countMatches(pC, draw.numbers),
        });
        console.log(`  Backfilled round ${draw.round}`);
    }

    return [...newEntries, ...stored]
        .sort((a, b) => getRoundNum(b.round) - getRoundNum(a.round))
        .slice(0, 10);
}

// ------------------------------------------------------------------ //
//  メイン
// ------------------------------------------------------------------ //

async function main() {
    console.log('=== preloto predict.js ===');
    console.log('Fetching sheet data...');
    const sheetData = await fetchSheetData();
    console.log(`Loaded ${sheetData.length} rounds from spreadsheet`);

    let stored = loadHistory();
    console.log(`Current history: ${stored.length} entries`);

    // 結果照合: result が null のエントリを更新
    let resultsUpdated = false;
    stored.forEach(entry => {
        if (entry.result !== null) return;
        const roundNum = getRoundNum(entry.round);
        const found = sheetData.find(h => h.round === roundNum);
        if (!found) return;
        entry.result = found.numbers;
        entry.matchA = countMatches(entry.predictions.patternA, entry.result);
        entry.matchB = countMatches(entry.predictions.patternB, entry.result);
        entry.matchC = countMatches(entry.predictions.patternC, entry.result);
        resultsUpdated = true;
        console.log(`Updated result for ${entry.round}: A=${entry.matchA} B=${entry.matchB} C=${entry.matchC}`);
    });

    // backfill: 10件未満なら過去分を補完
    if (stored.length < 10) {
        stored = await backfill(sheetData, stored);
    }

    // 最新の次回予想を追加（重複チェック）
    const nextRound      = sheetData[0].round + 1;
    const nextRoundLabel = `第${nextRound}回`;
    if (!stored.some(e => e.round === nextRoundLabel)) {
        const analysis = analyzeData(sheetData);
        const pA = analysis.patternA.map(s => s.num);
        const pB = analysis.patternB.map(s => s.num);
        const pC = analysis.patternC.map(s => s.num);
        const newEntry = {
            round:       nextRoundLabel,
            date:        new Date().toISOString().slice(0, 10),
            predictions: { patternA: pA, patternB: pB, patternC: pC },
            result:      null,
            matchA:      null,
            matchB:      null,
            matchC:      null,
        };
        stored = [newEntry, ...stored];
        if (stored.length > 10) stored = stored.slice(0, 10);
        console.log(`Added new prediction for ${nextRoundLabel}`);
    }

    saveHistory(stored);
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
