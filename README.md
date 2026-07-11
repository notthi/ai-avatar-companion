# ai-avatar-companion

自分のPCに住む「本物のAIエージェント」に、3Dの体と声を与えるためのアプリです。
スマホに話しかけると、あなたのVRMキャラクターが約2秒で答えます。

- 🧠 頭脳: [Hermes Agent](https://github.com/nousresearch/hermes-agent)(永続記憶を持つ自宅サーバー型エージェント。OpenClawにも対応)
- 🗣 声: [VOICEVOX](https://voicevox.hiroshiba.jp/)(日本語)+ 端末内蔵の英語音声(英会話モード)
- 🧍 体: VRM 1.0(VRoid Studioで自作可能)。口パク・感情表情・ダンス・タッチ反応・傾きパララックス
- 📱 スマホ対応PWA(Tailscale経由のHTTPSでマイクも動作)

## 主な機能

- 音声会話(ストリーミング応答+文単位TTSで体感約2秒)・連続会話モード・相づち
- 文字入力モード / 話速設定 / 時間帯挨拶 / 放置するとうとうと居眠り
- 英会話練習モード(初級=中学単語・上級=ビジネス、添削あり/英語のみ)
- キャラをタップすると照れる・くすぐったがる等のランダム反応

## クイックスタート

詳しい手順書(セットアップの教科書)は準備中です。概要:

```bash
git clone https://github.com/notthi/ai-avatar-companion.git
cd ai-avatar-companion
npm install
copy .env.example .env   # Mac/Linux: cp .env.example .env
# .env にHermes AgentのAPIサーバー情報を記入
npm run build
npm run serve:lan        # http://localhost:8787
```

前提:
1. **Hermes Agent** が同じPCで稼働し、APIサーバーが有効なこと(`API_SERVER_ENABLED=true`)
2. **VOICEVOX** が起動していること(無いときはOS標準音声にフォールバック)
3. `public/avatar.vrm` にVRM1.0モデルを配置(無いときは絵文字アバターで動作)

スマホから使う場合は [Tailscale](https://tailscale.com/) を導入して `tailscale serve --bg 8787` でHTTPS配信してください(Web Speech APIがHTTPS必須のため)。

## 設定(.env)

`.env.example` を参照してください。主な項目:

| 変数 | 説明 |
|---|---|
| `GATEWAY_KIND` | `hermes` または `openclaw` |
| `GATEWAY_URL` / `GATEWAY_TOKEN` | エージェントAPIの接続先とキー |
| `SESSION_KEY` | 会話文脈の識別子 |
| `VOICEVOX_SPEAKER` / `VOICEVOX_SPEED` | 話者IDと話速 |

## クレジット

- 音声合成に [VOICEVOX](https://voicevox.hiroshiba.jp/) を使用する場合は、利用する音声ライブラリの利用規約に従いクレジット表記をしてください(例: `VOICEVOX:春日部つむぎ`)
- VRMの表示には [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) を使用しています

## License

MIT
