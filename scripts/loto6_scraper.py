#!/usr/bin/env python3
"""
ロト6最新抽選結果をスクレイピングしてGoogleスプレッドシートに追記する。

取得元: https://takarakuji.rakuten.co.jp/backnumber/loto6/
  ※みずほ銀行のページはAkamai WAFでAccess Deniedのため楽天宝くじを使用
転記先: LOTO6用Googleスプレッドシート（新規作成）
  シート名: 結果

列構成（A〜H列）:
  A: 回別 / B: 抽選日 / C〜H: 本数字1〜6 / I: ボーナス数字

重複防止:
  - 書き込み前にシートの最終回号を確認し、同じ回が登録済みなら書き込まない
  - スキップ時は "SKIP: ... already registered" を出力（cron skip_patternで検知）
"""

import sys
import re
import json
import urllib.request
import urllib.error
import logging
from pathlib import Path
from typing import Optional

# google_sheets.py を common_tools から import
COMMON_TOOLS = Path("/home/umi/.animaworks/common_tools")
sys.path.insert(0, str(COMMON_TOOLS))

from google_sheets import GoogleSheetsClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

LOTO6_URL = "https://takarakuji.rakuten.co.jp/backnumber/loto6/"
LOTO6_DETAIL_BASE = "https://takarakuji.rakuten.co.jp/backnumber/loto6_detail/{start:04d}-{end:04d}/"
SHEET_NAME = "LOTO6結果"
CONFIG_FILE = Path(__file__).parent.parent / ".loto6_sheet_id"


def fetch_all_results() -> list:
    """第1回から最新回まで全ロト6抽選結果を取得する。

    Returns:
        [{"kaigou": "第1回", "date": "2000年10月05日", "honsu": [...], "bonus": ...}, ...]
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        raise RuntimeError(
            "BeautifulSoupが未インストール。以下を実行してください:\n"
            "  pip install beautifulsoup4 lxml"
        )

    all_results = []
    max_pages = 110  # 約2093回 / 20件 = 約105ページ + 余裕

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
    }

    for page_num in range(max_pages):
        start_kaigou = page_num * 20 + 1
        end_kaigou = start_kaigou + 19
        url = LOTO6_DETAIL_BASE.format(start=start_kaigou, end=end_kaigou)

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                content = resp.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            if e.code in [404, 500]:
                logger.info(f"ページ取得終了 (page {page_num}: {e.code})")
                break
            raise
        except Exception as e:
            logger.error(f"ページ取得エラー ({url}): {e}")
            raise

        soup = BeautifulSoup(content, "html.parser")

        # テーブル取得（詳細ページは tblType02 tblNumberGuid）
        table = soup.find("table", class_="tblNumberGuid")
        if not table:
            logger.warning(f"テーブルが見つかりません ({url})")
            break

        # データ行を抽出（ヘッダー行をスキップ）
        rows = table.find_all("tr")[1:]  # 最初のトリはヘッダー

        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 8:
                continue

            # パース
            raw_kaigou = cells[0].get_text(strip=True)  # 「第0001回」
            raw_date = cells[1].get_text(strip=True)    # 「2000/10/05」
            honsu = [cells[i].get_text(strip=True) for i in range(2, 8)]  # 6個
            bonus = cells[8].get_text(strip=True)       # ボーナス

            # 回号を正規化（「第0001回」→「第1回」）
            m = re.match(r"第0*(\d+)回", raw_kaigou)
            if not m:
                logger.warning(f"回号パース失敗: {raw_kaigou}")
                continue
            kaigou = f"第{m.group(1)}回"

            # 抽選日を正規化（「2000/10/05」→「2000年10月05日」）
            m = re.match(r"(\d{4})/(\d{2})/(\d{2})", raw_date)
            if not m:
                logger.warning(f"抽選日パース失敗: {raw_date}")
                continue
            chusen_date = f"{m.group(1)}年{m.group(2)}月{m.group(3)}日"

            all_results.append({
                "kaigou": kaigou,
                "date": chusen_date,
                "honsu": honsu,
                "bonus": bonus,
            })

        logger.info(f"ページ {page_num + 1}/{max_pages}: {start_kaigou:04d}-{end_kaigou:04d} ({len(rows)}件) 累計: {len(all_results)}件")

    logger.info(f"全履歴取得完了: 合計 {len(all_results)} 件")
    return all_results


def fetch_latest_result() -> dict:
    """楽天宝くじのページから最新ロト6抽選結果を取得する。"""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        raise RuntimeError(
            "BeautifulSoupが未インストール。以下を実行してください:\n"
            "  pip install beautifulsoup4 lxml"
        )

    req = urllib.request.Request(
        LOTO6_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
        },
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read().decode("utf-8", errors="ignore")

    soup = BeautifulSoup(content, "html.parser")

    # 最初のテーブル（最新回）を取得
    tables = soup.find_all("table", class_="tblType02")
    if not tables:
        raise ValueError("ロト6テーブルが見つかりません。ページ構造が変わった可能性があります。")

    table = tables[0]
    rows = {th.get_text(strip=True): tr for tr in table.find_all("tr")
            for th in tr.find_all("th")}

    # 回号: 「第0670回」→「第670回」
    kaigou_row = table.find("tr")
    raw_kaigou = kaigou_row.find("th", class_="tit").find_next_sibling("th").get_text(strip=True)
    m = re.match(r"第0*(\d+)回", raw_kaigou)
    if not m:
        raise ValueError(f"回号のパース失敗: {raw_kaigou}")
    kaigou = f"第{m.group(1)}回"

    # 抽選日: 「2026/03/27」→「2026年03月27日」
    chusen_row = rows.get("抽せん日")
    if not chusen_row:
        raise ValueError("抽せん日の行が見つかりません。")
    raw_date = chusen_row.find("td").get_text(strip=True)
    m = re.match(r"(\d{4})/(\d{2})/(\d{2})", raw_date)
    if not m:
        raise ValueError(f"抽選日のパース失敗: {raw_date}")
    chusen_date = f"{m.group(1)}年{m.group(2)}月{m.group(3)}日"

    # 本数字1〜6（LOTO6は6個）
    honsu_row = rows.get("本数字")
    if not honsu_row:
        raise ValueError("本数字の行が見つかりません。")
    honsu_cells = [
        span.get_text(strip=True)
        for span in honsu_row.find_all("span", class_="loto-font-large")
    ]
    if len(honsu_cells) != 6:
        raise ValueError(f"本数字が6個取れませんでした（取得: {len(honsu_cells)}個）: {honsu_cells}")

    # ボーナス数字1個: 「(15)」→「15」
    bonus_row = rows.get("ボーナス数字")
    if not bonus_row:
        raise ValueError("ボーナス数字の行が見つかりません。")
    bonus_cells = []
    for span in bonus_row.find_all("span", class_="loto-highlight"):
        text = span.get_text(strip=True)
        num = re.sub(r"[()]", "", text)
        if num:
            bonus_cells.append(num)
    if len(bonus_cells) < 1:
        raise ValueError(f"ボーナス数字が取得できませんでした: {bonus_cells}")
    bonus = bonus_cells[0]  # LOTO6は1個のボーナス

    return {
        "kaigou": kaigou,
        "date": chusen_date,
        "honsu": honsu_cells,
        "bonus": bonus,
    }


def get_last_registered_kaigou(client: GoogleSheetsClient, spreadsheet_id: str) -> Optional[str]:
    """スプレッドシートの最終行の回号（A列）を取得する。"""
    try:
        result = client.read_range(
            spreadsheet_id=spreadsheet_id,
            range_=f"{SHEET_NAME}!A:A",
        )
        rows = result.get("rows", [])
        # ヘッダー行を除いたデータ行
        data_rows = [r for r in rows if r and r[0] and r[0] != "回別"]
        if not data_rows:
            return None
        return data_rows[-1][0]
    except Exception as e:
        logger.warning(f"既存データ確認失敗（新規スプレッドシート？）: {e}")
        return None


def normalize_kaigou(kaigou: str) -> int:
    """「第670回」→ 670 として比較用に数値を返す。"""
    m = re.search(r"(\d+)", kaigou)
    return int(m.group(1)) if m else 0


def create_spreadsheet(client: GoogleSheetsClient, title: str = "LOTO6 抽選結果") -> str:
    """新しいGoogleスプレッドシートを作成し、IDを返す。"""
    from googleapiclient.discovery import build as build_api

    service = client._get_service()

    spreadsheet_body = {
        "properties": {"title": title},
        "sheets": [
            {
                "properties": {"sheetId": 0, "title": SHEET_NAME},
            }
        ],
    }

    request = service.spreadsheets().create(body=spreadsheet_body)
    response = request.execute()
    spreadsheet_id = response.get("spreadsheetId")
    logger.info(f"スプレッドシート作成完了: {spreadsheet_id}")

    # ヘッダー行を追加
    header = ["回別", "抽選日", "本数字1", "本数字2", "本数字3", "本数字4", "本数字5", "本数字6", "ボーナス数字"]
    client.write_range(
        spreadsheet_id=spreadsheet_id,
        range_=f"{SHEET_NAME}!A1:I1",
        values=[header],
    )
    logger.info(f"ヘッダー行を追加: {header}")

    return spreadsheet_id


def main() -> None:
    logger.info("ロト6最新1件の処理を開始します...")

    client = GoogleSheetsClient()

    # スプレッドシートIDを確認または作成
    spreadsheet_id = None
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                config = json.load(f)
                spreadsheet_id = config.get("spreadsheet_id")
                logger.info(f"既存スプレッドシートを使用: {spreadsheet_id}")
        except Exception as e:
            logger.warning(f"設定ファイル読み込み失敗: {e}")

    if not spreadsheet_id:
        logger.info("新しいスプレッドシートを作成します...")
        spreadsheet_id = create_spreadsheet(client, "LOTO6 抽選結果")
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump({"spreadsheet_id": spreadsheet_id}, f, indent=2)
        logger.info(f"スプレッドシートID保存: {CONFIG_FILE}")

    # 1. 最新1件のスクレイピング
    logger.info("最新ロト6抽選結果を取得します...")
    try:
        latest = fetch_latest_result()
    except Exception as e:
        logger.error(f"最新データ取得失敗: {e}")
        print(f"ERROR: Failed to fetch latest result: {e}")
        return

    logger.info(f"最新回号: {latest['kaigou']} ({latest['date']})")

    # 2. 重複チェック
    last_kaigou = get_last_registered_kaigou(client, spreadsheet_id)
    logger.info(f"シートの最終回号: {last_kaigou}")

    if last_kaigou and normalize_kaigou(latest["kaigou"]) <= normalize_kaigou(last_kaigou):
        msg = f"SKIP: {latest['kaigou']} already registered"
        logger.info(msg)
        print(msg)
        return

    # 3. 最新1件を追記
    logger.info(f"新規データを追記します: {latest['kaigou']}")

    # 現在のデータ行数を取得（ヘッダー行を除く）
    try:
        result = client.read_range(
            spreadsheet_id=spreadsheet_id,
            range_=f"{SHEET_NAME}!A:A",
        )
        rows = result.get("rows", [])
        data_rows = [r for r in rows if r and r[0] and r[0] != "回別"]
        next_row = len(data_rows) + 2  # ヘッダー行（1行） + 既存データ行数 + 1
    except Exception as e:
        logger.warning(f"行数確認失敗: {e}")
        next_row = 2  # デフォルトで2行目に書き込み

    # 新規行を追記
    new_row = [latest["kaigou"], latest["date"]] + latest["honsu"] + [latest["bonus"]]
    write_result = client.write_range(
        spreadsheet_id=spreadsheet_id,
        range_=f"{SHEET_NAME}!A{next_row}:I{next_row}",
        values=[new_row],
    )
    updated_range = write_result.get("updates", {}).get("updatedRange", "unknown")
    logger.info(f"書き込み完了: {updated_range}")

    print(f"OK: {latest['kaigou']} ({latest['date']}) を追記しました")

    # スプレッドシートIDを出力（タスク完了時に報告用）
    print(spreadsheet_id)


if __name__ == "__main__":
    main()
