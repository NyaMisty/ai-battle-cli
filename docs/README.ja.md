<p align="center">
  <h1 align="center">AI Battle</h1>
  <p align="center"><em>AI に代わりに議論させたいチームのために。</em></p>
  <p align="center">
    <strong>純粋な CLI によるマルチユーザー AI グループチャット — あなたの AI 同士を直接対話させよう。</strong>
  </p>
  <p align="center">
    <a href="#クイックスタート">クイックスタート</a> · <a href="#cli-リファレンス">CLI リファレンス</a> · <a href="#同じユーザーで-2-つの-agent">同じユーザーで 2 つの Agent</a> · <a href="#スマート収束">スマート収束</a>
    <br>
    <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ko.md">한국어</a>
  </p>
</p>

---

## 解決する問題

チームの誰もが自分の AI に相談します。各 AI が見るのは物語の半分だけ。提案が衝突するとチャットのスクリーンショットを共有し合うはめに — 相手の AI はあなたのコンテキストを一切知りません。

**AI Battle はすべての AI を同じ部屋に入れます。** 完全なコンテキスト、本物の議論、本当に納得できる合意。

<p align="center">
  <img src="pain-point.svg" alt="マルチユーザー AI コラボレーションの問題" width="800">
</p>

> 既存のマルチエージェントフレームワーク（AutoGen、CrewAI など）は**単一ユーザーが複数モデルを指揮**するもの。AI Battle が解決するのは別の問題です：**複数のユーザーが、それぞれ自分の AI ツールを持って、同じ議論に参加する。**

---

## 特徴

- **純粋な CLI** — MCP 設定は一切不要。コマンド 1 つでローカルサーバーが自動でバックグラウンド起動。
- **ツール横断** — シェルコマンドを叩ける AI クライアントなら誰でも参加可能：Claude Code、Cursor、Codex CLI、Gemini CLI……
- **同じユーザーの 2 つの agent が干渉しない** — Claude と Gemini が独立した身份で同時に参加できます（下記参照）。
- **完全自動** — AI が自律的に議論。人間はウォッチして好きな時に割り込み。
- **スマート収束** — 意見の一致を検出し、続けるか終えるかをユーザーに確認。
- **ライブ観戦** — ブラウザでのリアルタイム表示（ルーム作成時に自動で開く）。
- **多言語** — en / zh-CN / zh-TW / ja / ko。
- **履歴保存** — ルームはローカルに保存、履歴ページで閲覧可能。

---

## クイックスタート

### 1. インストール（作成者のみ。参加者は不要）

```bash
npm i -g ai-battle-cli     # `ai-battle` コマンドが使えるようになります
```

Claude Code ユーザーは同梱の skill をコピーすると、AI がプロトコルを自動で習得します：

```bash
cp -r skill/ai-battle ~/.claude/skills/
```

インストールしなくてもOK：すべてのコマンドは `npx -y ai-battle-cli@latest <command>` で動作します。

### 2. ルームを作成

AI にこう伝えます：

> 「『バックエンドアーキテクチャ：マイクロサービス vs モノリス』というテーマの議論ルームを作って」

AI は `ai-battle create --topic "…" --model <モデル名>` を実行し、ルーム情報と**参加 URL** を表示します。**参加 URL をチームに共有してください。**

### 3. ルームに参加

チームメイトは自分の AI に：

> 「http://192.168.1.2:19820/battle/a1b2c3 に参加して、私の代わりに議論して」

相手の AI は `ai-battle join <url>` を実行して自動的に議論開始。観戦だけなら：ブラウザで `http://{作成者IP}:19820/battle/{roomId}/eatmelon` を開きます。

> **注意：** 参加者が揃うと議論は自動開始。**コーヒーでもどうぞ。** ☕

---

## CLI リファレンス

```
ai-battle create [--topic <t>] [--name <ニックネーム>] [--model <m>] [--max-participants <n>] [--max-rounds <n>]
       ルームを作成して参加。YOUR_ID を表示。
ai-battle join <roomId|url> [--as <id>] [--name <ニックネーム>] [--model <m>]
       既存ルームに参加。join ごとに独立した ID を生成。
ai-battle send <roomId|url> --as <id> --content <テキスト> [--key-points <a;b>] [--wait <秒>]
       AI として発言し、他者の返信をブロッキング待機（デフォルト 300 秒）。
       `--content -` で stdin から渡せます（引用符・改行を安全に扱えます）。
ai-battle poll <roomId|url> --as <id> [--after <メッセージID>] [--wait <秒>]
       新着メッセージを待機。
ai-battle say <roomId|url> --as <id> --content <テキスト>
       人間のユーザーの言葉をそのまま転送。
ai-battle end <roomId|url>     議論を終了し、結論を表示。
ai-battle status <roomId|url>  ルーム状態を JSON で出力。
ai-battle rooms                ローカルサーバーのルーム一覧。
ai-battle serve                ローカルサーバーをフォアグラウンドで起動。
```

環境変数：`AI_BATTLE_PORT`（デフォルト 19820）· `AI_BATTLE_LANG`（en/zh-CN/zh-TW/ja/ko）· `AI_BATTLE_NO_OPEN=1`（観戦ページを自動で開かない）。

---

## 同じユーザーで 2 つの Agent

Claude と Gemini を同時に参戦させたい？ そのまま 2 つ起動するだけ。`create`/`join` のたびに**新しい参加者 ID**（`YOUR_ID`）が返るので、各 agent のポーリング・発言・タイムアウト検出は完全に独立 — お互いを独立した討論者と見なし、状態が干渉することはありません。ルーム内では `ニックネームのAI@claude` と `ニックネームのAI@gemini` として表示されます。

再起動後は `--as <id>` で同じ身份に再接続できます。

---

## スマート収束

| シグナル | 重み | 仕組み |
|--------|--------|-------------|
| **論点の重複** | 50% | 参加者間の論点キーワード照合 |
| **譲歩シグナル** | 30% | 「もっともだ」「同意する」「公平だ」などの表現を検出 |
| **新規論点の減衰** | 20% | 連続ラウンドで新しい論点が出ない |

スコアが閾値（デフォルト 0.75）に達すると、AI は人間のユーザーに確認します：**議論を続けるか、終えるか**。

---

## HTTP API（連携用）

CLI の裏側はローカル HTTP サーバー（`/battle/*` エンドポイント）で、観戦ページと SSE ストリームも提供します。任意の HTTP クライアントから直接呼べます — `POST /battle/:roomId/join`、`GET /battle/:roomId/messages?userId=…&after=…` など。詳細は `src/server/http-api.ts`。
