# dsh-plamo-translate

Translate DeepSeek Harness Thinking through a configurable PLaMo API. Includes optional Windows-local startup for PLaMo 3 Translate 0.8B.

DeepSeek Harness Webの展開したThinkingを、PLaMoの翻訳API経由で日本語に表示するプラグインです。

- 確定した段落を順番に翻訳し、未確定の末尾は原文を表示します。
- 原文と翻訳を切り替えられます。モデルへ渡す元の履歴を置き換えません。
- 成功した訳をセッションに保存し、再表示やHarness再起動後に再利用します。
- 翻訳APIの停止や途中で打ち切られた訳は、原文表示と再試行で扱います。
- Windowsでは、Harness起動時にローカルの翻訳APIを起動・再利用できます。

## 対応環境

- DeepSeek Harness **0.2.2-rc.1**、Node.js **24.9以上**
- 開発・ローカルリンク導入: pnpm 10、Python 3.11以上
- 同梱の自動セットアップ: Windows x64、CUDA 12.4に対応するNVIDIAドライバー
- 既存APIを使う場合: PLaMo用テンプレートに対応したChat Completions API

段落分割・表示・翻訳結果の永続化はHarnessの実験的翻訳機能をベースにしています。Harnessの別バージョンへの対応は未確認です。公式のReasoning translationとは同時に有効化しないでください。

## WindowsでローカルAPIを自動起動する

```powershell
git clone https://github.com/nnsi/dsh-plamo-translate.git
cd dsh-plamo-translate
pnpm install --ignore-scripts
python scripts/setup.py
dsh plugin --profile web add "link:$($PWD.Path)" --ignore-scripts
dsh web
```

`setup.py`は公式配布元からllama.cppとPLaMo 0.8BのQ4_K_Mを取得し、SHA256を検証して`.runtime/`へ保存します。モデル重みは約573MBです。CUDAランタイムなどを含め、ダウンロードと展開には追加の空き容量が必要です。

プラグインが有効な状態でHarness本体が起動すると、`127.0.0.1:18080`のAPIを確認し、停止していれば起動します。既に同じモデルが起動していれば再利用します。起動時のモデル名は`plamo-3-translate-0.8b`です。

Webを再読み込みし、Thinkingを開くと翻訳を開始します。Pluginsの「Thinkingの翻訳（PLaMo）」から、翻訳先の言語を変更できます。

## 既存のPLaMo APIを使う

モデルのダウンロードを省略し、プラグインを追加する前に、対象プロファイルの`cordis.patch.yml`へ次の設定を追記します。通常のwebプロファイルは`$env:USERPROFILE/.dsh/profiles/web/cordis.patch.yml`です。

```yaml
- id: plamo-translation-api
  config:
    autoStart: false
- id: translator
  config:
    plamoEndpoint: http://127.0.0.1:18080/v1/chat/completions
    plamoModel: plamo-3-translate-0.8b
    # 認証を使う場合だけ、APIキーが入った環境変数の名前を設定する
    # plamoApiKeyEnv: PLAMO_API_KEY
- id: cot-translation
  config:
    targetLanguage: ja
```

続いて上の`dsh plugin ... add`と`dsh web`を実行します。既存APIのURL・モデル名に合わせて設定してください。LinuxやmacOSでは、この方式で管理済みのPLaMo APIに接続します。

APIキーを使う場合は、Harnessプロセスの起動環境にその変数を設定してください。設定ファイルやリポジトリへキー本体を書く必要はありません。翻訳文は指定したAPIに送られ、他の翻訳サービスには自動で切り替わりません。

リクエストは`chat_template_kwargs.target_lang`と、明示時は`source_lang`を送ります。サーバーには[PLaMo公式のチャットテンプレート](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)を設定してください。

## 設定

設定はプロファイルのパッチで上書きできます。

| エントリ | 項目 | 既定値 | 用途 |
| --- | --- | --- | --- |
| `plamo-translation-api` | `autoStart` | `true` | WindowsでAPIを起動・再利用する |
| 同上 | `runtimeDirectory` | `.runtime` | このパッケージからの相対パス、または実行時の任意パス |
| 同上 | `port` | `18080` | 管理するローカルAPIのポート |
| `translator` | `plamoEndpoint` | `http://127.0.0.1:18080/v1/chat/completions` | 翻訳API |
| 同上 | `plamoModel` | `plamo-3-translate-0.8b` | API上のモデル名 |
| 同上 | `plamoApiKeyEnv` | 空文字 | APIキーを読む環境変数名 |
| 同上 | `plamoMaxOutputTokens` | `2048` | 翻訳の出力上限 |
| 同上 | `maxTextChars` | `1200` | 分割する原文の最大UTF-16コード単位数 |
| 同上 | `timeoutMs` | `60000` | リクエストの待ち時間 |
| `cot-translation` | `targetLanguage` | `ja` | 翻訳先言語。`auto`はUI言語に追従 |

管理するAPIのポートを変更するときは`plamoEndpoint`も合わせて変更します。別の実行時ディレクトリを使う場合は`python scripts/setup.py --runtime-dir ...`と`runtimeDirectory`を合わせてください。

## 停止・再起動・解除

- ブラウザのタブを閉じても、翻訳APIは稼働を継続します。
- Harnessやプラグインを終了しても、再利用するAPIプロセスは残します。
- Windows再起動後は、Harnessを起動するとAPIも起動します。Windowsログイン時の自動起動設定は追加しません。
- 稼働途中に翻訳APIが異常終了した場合の常時監視・自動復旧はありません。APIを再起動するか、プラグインを再度有効化してください。
- ログは`.runtime/logs/`、APIのPIDは`.runtime/llama.pid`です。

解除:

```powershell
dsh plugin --profile web remove dsh-plamo-translate --ignore-scripts
```

折りたたみ中の短いプレビューは原文のままです。翻訳結果のMarkdownやコード片の表現が変わる場合は原文を参照してください。

## 開発・検証

```powershell
pnpm install --ignore-scripts
pnpm test
pnpm run check:privacy
pnpm run build:vendor
git diff --exit-code -- vendor upstream.json
pnpm pack
pnpm run smoke
```

`scripts/build-vendor.py`は固定バージョンのインストール済みHarnessから必要なコードだけを生成します。別のインストール先は`--dsh-dir`で指定できます。npmとpnpmの両方の依存配置を扱い、グローバルのHarnessパッケージを書き換えません。

APIの送信内容、途中打ち切り・空出力、失敗時の外部サービス不使用、キャンセルを自動検査します。モデルや実際のAPI呼び出しを使わずにテストできます。公開ファイル検査は、ローカルパス、プライベートIP、メールアドレス、代表的な認証情報の形式、実行時ファイルの混入を検出します。

`smoke`は専用の一時プロファイルと偽の翻訳APIを作り、tarballのインストール、認証付きRPC、クライアントJSの配信、再起動後のキャッシュ再利用を確認します。普段のプロファイルや実際のモデルは使いません。

Harnessのライブラリは実行中の本体が提供するoptional peerとして扱います。プロファイル内へ別コピーを自動導入するとセッションのクラスが分離するためです。開発用の依存関係は、このリポジトリでのテストとコード生成に使います。

モデル、バイナリ、ログ、ローカル設定、セッション、認証情報はGitと配布パッケージに含めません。

## ライセンス

プラグインはMITです。Harnessから派生した部分のライセンスと出典は[NOTICE](NOTICE)と[vendor/LICENSE.upstream](vendor/LICENSE.upstream)に記載しています。

PLaMoのモデルは別配布で、[PLaMo Community License](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)に従います。llama.cppも公式配布元から別途取得します。
