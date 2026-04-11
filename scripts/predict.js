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

// ---- LOTO7 定数 ----
const LOTO7_SHEET_ID  = '1y_8fEZpj7rvJdx3AOMSxjxLsNh_zso2d_b1EVEZWNB4';

// ---- LOTO6 定数 ----
const LOTO6_SHEET_ID  = '';      // 後で差し替え
const LOTO6_MAX_NUM   = 43;
const LOTO6_PICK      = 6;

// LOTO7/LOTO6 パラメータ
const LOTO7_PARAMS = { maxNum: 37, selectCount: 7, hasBonus: true, bonusCount: 2 };
const LOTO6_PARAMS = { maxNum: 43, selectCount: 6, hasBonus: true, bonusCount: 1 };

const HISTORY_PATH = path.join(__dirname, '../data/history.json');

// ------------------------------------------------------------------ //
//  CSV 取得・パース
// ------------------------------------------------------------------ //

async function fetchSheetData(sheetId, params) {
    if (!sheetId) {
        console.log(`⚠️  Sheet ID is empty for loto${params.selectCount === 6 ? 6 : 7}, skipping fetch`);
        return [];
    }
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Spreadsheet fetch failed: ${res.status}`);
    return parseCSV(await res.text(), params);
}

// LOTO6専用: Google Sheets からCSVデータを取得
async function fetchLoto6SheetData() {
    if (!LOTO6_SHEET_ID) {
        console.log(`⚠️  Sheet ID is empty for LOTO6, skipping fetch`);
        return [];
    }
    const url = `https://docs.google.com/spreadsheets/d/${LOTO6_SHEET_ID}/gviz/tq?tqx=out:csv`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Spreadsheet fetch failed: ${res.status}`);
    return parseCSVLoto6(await res.text());
}

function parseCSV(csv, params) {
    const { maxNum, selectCount, bonusCount } = params;
    const data  = [];
    const lines = csv.split('\n');
    const expectedLength = selectCount + 2; // round + date + numbers + (bonus)

    for (let i = 1; i < lines.length; i++) {
        const line  = lines[i].replace(/"/g, '').trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length < expectedLength) continue;
        const roundNum = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
        if (isNaN(roundNum)) continue;

        // 本数字: parts[2] ~ parts[2+selectCount-1]
        const nums = [];
        for (let j = 0; j < selectCount; j++) {
            const num = parseInt(parts[2 + j], 10);
            if (!isNaN(num) && num >= 1 && num <= maxNum) {
                nums.push(num);
            }
        }
        if (nums.length !== selectCount) continue;

        // ボーナス数字: parts[2+selectCount] ~ parts[2+selectCount+bonusCount-1]
        const bonus = [];
        for (let j = 0; j < bonusCount; j++) {
            const b = parseInt(parts[2 + selectCount + j], 10);
            if (!isNaN(b) && b >= 1 && b <= maxNum) bonus.push(b);
        }

        data.push({ round: roundNum, date: parts[1], numbers: nums, bonus });
    }
    data.sort((a, b) => b.round - a.round);
    return data;
}

// LOTO6専用: CSV解析
function parseCSVLoto6(csv) {
    const maxNum = LOTO6_MAX_NUM;
    const selectCount = LOTO6_PICK;
    const bonusCount = 1;  // LOTO6: 1個のボーナス数字
    const data  = [];
    const lines = csv.split('\n');
    const expectedLength = selectCount + 2; // round + date + numbers + bonus

    for (let i = 1; i < lines.length; i++) {
        const line  = lines[i].replace(/"/g, '').trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length < expectedLength) continue;
        const roundNum = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
        if (isNaN(roundNum)) continue;

        // 本数字: parts[2] ~ parts[2+selectCount-1]
        const nums = [];
        for (let j = 0; j < selectCount; j++) {
            const num = parseInt(parts[2 + j], 10);
            if (!isNaN(num) && num >= 1 && num <= maxNum) {
                nums.push(num);
            }
        }
        if (nums.length !== selectCount) continue;

        // ボーナス数字: parts[2+selectCount]
        const bonus = [];
        const b = parseInt(parts[2 + selectCount], 10);
        if (!isNaN(b) && b >= 1 && b <= maxNum) bonus.push(b);

        data.push({ round: roundNum, date: parts[1], numbers: nums, bonus });
    }
    data.sort((a, b) => b.round - a.round);
    return data;
}

// ------------------------------------------------------------------ //
//  予想アルゴリズム（LOTO7/LOTO6対応）
// ------------------------------------------------------------------ //

function analyzeData(historyData, params) {
    const { maxNum, selectCount, bonusCount } = params;
    const arraySize    = maxNum + 1;
    const counts       = new Array(arraySize).fill(0);
    const last10Counts = new Array(arraySize).fill(0);
    const bonusCounts  = new Array(arraySize).fill(0);  // ボーナス数字出現回数
    const lastSeen     = new Array(arraySize).fill(-1);
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
            drawObj.bonus.forEach(b => { if (b >= 1 && b <= maxNum) bonusCounts[b]++; });
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
        if (n - 1 >= 1)      prevNeighbors.add(n - 1);
        if (n + 1 <= maxNum) prevNeighbors.add(n + 1);
    });

    const hotNumbers  = [];
    const coldNumbers = [];
    for (let i = 1; i <= maxNum; i++) {
        if (last10Counts[i] >= 3) hotNumbers.push(i);
        if (last10Counts[i] === 0) coldNumbers.push(i);
    }

    // スコアリング（新D条件: ① ② ⑥）
    // ② 直近5回の集計（修正②）
    const last5Counts = new Array(arraySize).fill(0);
    historyData.slice(0, 5).forEach(drawObj => {
        drawObj.numbers.forEach(num => last5Counts[num]++);
    });

    const scores = [];
    for (let i = 1; i <= maxNum; i++) {
        let score = counts[i] * 2;

        // ① 直近10回の出現頻度重み付け
        score += last10Counts[i] * 50;

        // ② 直近5回に出現していない場合はペナルティ
        if (last5Counts[i] === 0) score -= 80;

        // ② 連番ペア（前回当選の±1番号をスコア加点）
        if (prevNeighbors.has(i)) score += 40;

        // ペア相性
        let maxPairCount = 0;
        let bestPartner  = 0;
        for (let j = 1; j <= maxNum; j++) {
            if (i === j) continue;
            const p = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (pairs[p] && pairs[p] > maxPairCount) {
                maxPairCount = pairs[p];
                bestPartner  = j;
            }
        }
        if (maxPairCount >= 15) score += maxPairCount;

        // ボーナス数字スコアリング（LOTO7のみ、LOTO6ではスキップ）
        if (bonusCount > 0 && bonusCounts[i] >= 3) {
            score += bonusCounts[i] * 3;
        }

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

    // ③ 奇数偶数バランス（全偶数・全奇数を除外）
    const isOddEvenOk = nums => {
        const e = nums.filter(n => n % 2 === 0).length;
        // LOTO7: e >= 1 && e <= 6, LOTO6: e >= 1 && e <= 5
        return e >= 1 && e <= (selectCount - 1);
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

    // ---- パターン A「王道」: スコア上位 N個 ----
    const patternA = applyConstraints(scores.slice(0, selectCount).sort((a, b) => a.num - b.num));

    // ---- パターン B「逆張り」: 冷え (selectCount-2) + 暖 2 ----
    const coldPool = scores.filter(s => s.last10 <= 1);
    const warmPool = scores.filter(s => s.last10 > 1);
    const bBase    = [...coldPool.slice(0, selectCount - 2), ...warmPool.slice(0, 2)]
        .slice(0, selectCount).sort((a, b) => a.num - b.num);
    const patternB = applyConstraints(bBase);

    // ---- パターン C「バランス」: 熱(selectCount-4) + 冷2 + ペア2 ----
    const hotPool    = scores.filter(s => hotNumbers.includes(s.num));
    const coldPool2  = scores.filter(s => coldNumbers.includes(s.num));
    const pairSorted = [...scores].sort((a, b) => b.maxPairCount - a.maxPairCount);

    const c_hot  = hotPool.slice(0, selectCount - 4);
    const usedC  = new Set(c_hot.map(s => s.num));
    const c_cold = coldPool2.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_cold.forEach(s => usedC.add(s.num));
    const c_pair = pairSorted.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_pair.forEach(s => usedC.add(s.num));
    let cBase = [...c_hot, ...c_cold, ...c_pair];
    if (cBase.length < selectCount) {
        const fill = scores.filter(s => !usedC.has(s.num)).slice(0, selectCount - cBase.length);
        cBase = [...cBase, ...fill];
    }
    const patternC = applyConstraints(cBase.sort((a, b) => a.num - b.num));

    return { patternA, patternB, patternC, hotNumbers, coldNumbers, scores };
}

// LOTO6専用: 予想アルゴリズム（ボーナス数字スコアリングをスキップ）
function analyzeDataLoto6(historyData) {
    const maxNum = LOTO6_MAX_NUM;
    const selectCount = LOTO6_PICK;
    const arraySize    = maxNum + 1;
    const counts       = new Array(arraySize).fill(0);
    const last10Counts = new Array(arraySize).fill(0);
    const bonusCounts  = new Array(arraySize).fill(0);  // ボーナス数字出現回数（集計のみ、スコアリング時は使用しない）
    const lastSeen     = new Array(arraySize).fill(-1);
    const pairs        = {};

    historyData.forEach((drawObj, index) => {
        const draw = drawObj.numbers;
        draw.forEach(num => {
            counts[num]++;
            if (index < 10) last10Counts[num]++;
            if (lastSeen[num] === -1) lastSeen[num] = index;
        });
        // ボーナス数字の集計（スコアリング時は使用しない）
        if (drawObj.bonus) {
            drawObj.bonus.forEach(b => { if (b >= 1 && b <= maxNum) bonusCounts[b]++; });
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
        if (n - 1 >= 1)      prevNeighbors.add(n - 1);
        if (n + 1 <= maxNum) prevNeighbors.add(n + 1);
    });

    const hotNumbers  = [];
    const coldNumbers = [];
    for (let i = 1; i <= maxNum; i++) {
        if (last10Counts[i] >= 3) hotNumbers.push(i);
        if (last10Counts[i] === 0) coldNumbers.push(i);
    }

    // スコアリング
    const last5Counts = new Array(arraySize).fill(0);
    historyData.slice(0, 5).forEach(drawObj => {
        drawObj.numbers.forEach(num => last5Counts[num]++);
    });

    const scores = [];
    for (let i = 1; i <= maxNum; i++) {
        let score = counts[i] * 2;

        // ① 直近10回の出現頻度重み付け
        score += last10Counts[i] * 50;

        // ② 直近5回に出現していない場合はペナルティ
        if (last5Counts[i] === 0) score -= 80;

        // ② 連番ペア（前回当選の±1番号をスコア加点）
        if (prevNeighbors.has(i)) score += 40;

        // ペア相性
        let maxPairCount = 0;
        let bestPartner  = 0;
        for (let j = 1; j <= maxNum; j++) {
            if (i === j) continue;
            const p = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (pairs[p] && pairs[p] > maxPairCount) {
                maxPairCount = pairs[p];
                bestPartner  = j;
            }
        }
        if (maxPairCount >= 15) score += maxPairCount;

        // ⑥ LOTO6ではボーナス数字スコアリングをスキップ

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

    // ---- 後選択バリデーション ----

    // ③ 奇数偶数バランス（LOTO6: e >= 1 && e <= 5）
    const isOddEvenOk = nums => {
        const e = nums.filter(n => n % 2 === 0).length;
        return e >= 1 && e <= 5;  // LOTO6は6個選ぶので偶数は1～5個
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
        return initial;
    }

    // ---- パターン A「王道」: スコア上位 6個 ----
    const patternA = applyConstraints(scores.slice(0, selectCount).sort((a, b) => a.num - b.num));

    // ---- パターン B「逆張り」: 冷え 4 + 暖 2 ----
    const coldPool = scores.filter(s => s.last10 <= 1);
    const warmPool = scores.filter(s => s.last10 > 1);
    const bBase    = [...coldPool.slice(0, selectCount - 2), ...warmPool.slice(0, 2)]
        .slice(0, selectCount).sort((a, b) => a.num - b.num);
    const patternB = applyConstraints(bBase);

    // ---- パターン C「バランス」: 熱 2 + 冷 2 + ペア 2 ----
    const hotPool    = scores.filter(s => hotNumbers.includes(s.num));
    const coldPool2  = scores.filter(s => coldNumbers.includes(s.num));
    const pairSorted = [...scores].sort((a, b) => b.maxPairCount - a.maxPairCount);

    const c_hot  = hotPool.slice(0, selectCount - 4);
    const usedC  = new Set(c_hot.map(s => s.num));
    const c_cold = coldPool2.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_cold.forEach(s => usedC.add(s.num));
    const c_pair = pairSorted.filter(s => !usedC.has(s.num)).slice(0, 2);
    c_pair.forEach(s => usedC.add(s.num));
    let cBase = [...c_hot, ...c_cold, ...c_pair];
    if (cBase.length < selectCount) {
        const fill = scores.filter(s => !usedC.has(s.num)).slice(0, selectCount - cBase.length);
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
//  history.json 読み書き（LOTO7/LOTO6対応）
// ------------------------------------------------------------------ //

function loadHistory() {
    try {
        const dir = path.dirname(HISTORY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(HISTORY_PATH)) return { loto7: [], loto6: [] };

        const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));

        // 旧形式（配列）→ 新形式に自動変換
        if (Array.isArray(data)) {
            console.log('Migrating history.json from array to object format...');
            return { loto7: data, loto6: [] };
        }
        return data; // 新形式
    } catch {
        return { loto7: [], loto6: [] };
    }
}

function saveHistory(data) {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log(`history.json saved: loto7=${data.loto7?.length || 0} entries, loto6=${data.loto6?.length || 0} entries`);
}

// ------------------------------------------------------------------ //
//  backfill: history.json が10件未満の場合に過去分を遡って補完
// ------------------------------------------------------------------ //

async function backfill(sheetData, stored, params) {
    console.log(`Running backfill for LOTO${params.selectCount}...`);
    const target     = sheetData.slice(0, 10); // 最新10回分が対象
    const newEntries = [];

    for (const draw of target) {
        if (stored.some(e => getRoundNum(e.round) === draw.round)) continue;
        // その回より前のデータで予想を再計算
        const prevData = sheetData.filter(h => h.round < draw.round);
        if (prevData.length < 5) continue; // データが少なすぎる場合はスキップ

        const analysis = analyzeData(prevData, params);
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
        console.log(`  Backfilled LOTO${params.selectCount} round ${draw.round}`);
    }

    return [...newEntries, ...stored]
        .sort((a, b) => getRoundNum(b.round) - getRoundNum(a.round))
        .slice(0, 10);
}

// ------------------------------------------------------------------ //
//  LOTO型ごとのデータ更新
// ------------------------------------------------------------------ //

async function updateLotoData(sheetData, stored, params, lotoName) {
    console.log(`[${lotoName}] Processing...`);

    if (sheetData.length === 0) {
        console.log(`[${lotoName}] No sheet data available`);
        return stored;
    }

    // 結果照合: result が null のエントリを更新
    stored.forEach(entry => {
        if (entry.result !== null) return;
        const roundNum = getRoundNum(entry.round);
        const found = sheetData.find(h => h.round === roundNum);
        if (!found) return;
        entry.result = found.numbers;
        entry.matchA = countMatches(entry.predictions.patternA, entry.result);
        entry.matchB = countMatches(entry.predictions.patternB, entry.result);
        entry.matchC = countMatches(entry.predictions.patternC, entry.result);
        console.log(`  [${lotoName}] Updated result for ${entry.round}: A=${entry.matchA} B=${entry.matchB} C=${entry.matchC}`);
    });

    // backfill: 10件未満なら過去分を補完
    if (stored.length < 10) {
        stored = await backfill(sheetData, stored, params, lotoName);
    }

    // 最新の次回予想を追加（重複チェック）
    const nextRound      = sheetData[0].round + 1;
    const nextRoundLabel = `第${nextRound}回`;
    if (!stored.some(e => getRoundNum(e.round) === nextRound)) {
        const analysis = analyzeData(sheetData, params);
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
        console.log(`  [${lotoName}] Added new prediction for ${nextRoundLabel}`);
    }

    return stored;
}

// ------------------------------------------------------------------ //
//  メイン
// ------------------------------------------------------------------ //

async function main() {
    console.log('=== preloto predict.js (LOTO7 & LOTO6) ===');
    let history = loadHistory();

    // LOTO7処理
    try {
        const loto7SheetData = await fetchSheetData(LOTO7_SHEET_ID, LOTO7_PARAMS);
        history.loto7 = await updateLotoData(loto7SheetData, history.loto7, LOTO7_PARAMS, 'LOTO7');
        console.log(`LOTO7 history: ${history.loto7.length} entries`);
    } catch (e) {
        console.error('[LOTO7] Error:', e.message);
    }

    // LOTO6処理
    try {
        const loto6SheetData = await fetchSheetData(LOTO6_SHEET_ID, LOTO6_PARAMS);
        history.loto6 = await updateLotoData(loto6SheetData, history.loto6, LOTO6_PARAMS, 'LOTO6');
        console.log(`LOTO6 history: ${history.loto6.length} entries`);
    } catch (e) {
        console.error('[LOTO6] Error:', e.message);
    }

    saveHistory(history);
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
