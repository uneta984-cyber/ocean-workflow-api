require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const upload = multer({
  dest: "uploads/"
});
const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ========================================
// 基本設定
// ========================================

app.use(express.json());
app.use(express.static(__dirname));

const dataFolder = path.join(__dirname, "data");
const errorFolder = path.join(dataFolder, "errors");

fs.mkdirSync(dataFolder, { recursive: true });
fs.mkdirSync(errorFolder, { recursive: true });

// ========================================
// エラータンクへ保存する共通機能
// ========================================

function saveErrorToTank({
  error,
  stage,
  inputText = "",
  additionalData = {}
}) {
  const errorId = `ERR-${Date.now()}`;
  const createdAt = new Date().toISOString();

  const errorData = {
    error_id: errorId,
    created_at: createdAt,
    route: "/workflow",
    stage,
    input_text: inputText || "入力なし",
    error_message: error?.message || String(error),
    stack: error?.stack || "スタック情報なし",
    status: "unresolved",
    additional_data: additionalData
  };

  const errorFileName = `${errorId}.json`;
  const errorFilePath = path.join(errorFolder, errorFileName);

  try {
    fs.writeFileSync(
      errorFilePath,
      JSON.stringify(errorData, null, 2),
      "utf8"
    );

    console.error(`エラータンク保存成功: ${errorFileName}`);

    return {
      saved: true,
      errorId,
      fileName: errorFileName
    };
  } catch (saveError) {
    console.error("エラータンクへの保存にも失敗しました:", saveError);

    return {
      saved: false,
      errorId,
      fileName: null
    };
  }
}

// ========================================
// AIが返した文章をJSONへ変換
// ========================================

function parseAIResponse(outputText) {
  const cleanedText = outputText
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleanedText);
}

// ========================================
// 入力画面を表示
// ========================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/errors", (req, res) => {
  res.sendFile(path.join(__dirname, "errors.html"));
});
app.get("/expiry", (req, res) => {
  res.sendFile(
    path.join(__dirname, "expiry.html")
  );
});
app.get("/api/errors", (req, res) => {
  try {
    const files = fs
      .readdirSync(errorFolder)
      .filter((file) => file.endsWith(".json"));

    const errors = files
      .map((file) => {
        const filePath = path.join(errorFolder, file);
        const fileContent = fs.readFileSync(filePath, "utf8");
        return JSON.parse(fileContent);
      })
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
      );

    res.json({
      success: true,
      count: errors.length,
      errors
    });
  } catch (error) {
    console.error("エラー一覧取得失敗:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ========================================
// Workflow API
// ========================================
// ========================================
// エラー対応状態を更新するAPI
// ========================================
app.post("/api/errors/:errorId/resolve", (req, res) => {
  try {
    const { errorId } = req.params;
    const filePath = path.join(errorFolder, `${errorId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: "指定されたエラーが見つかりません。"
      });
    }

    const errorData = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    errorData.status = "resolved";
    errorData.resolved_at = new Date().toISOString();

    fs.writeFileSync(
      filePath,
      JSON.stringify(errorData, null, 2),
      "utf8"
    );

    return res.json({
      success: true,
      message: "エラーを対応済みにしました。",
      error: errorData
    });
  } catch (error) {
    console.error("エラー状態更新失敗:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ========================================
// Sky Data 共通JSON受け口
// ========================================
app.post("/api/workflow/intake", async (req, res) => {
  try {
    const {
      request_id,
      source_type,
      workflow_id,
      content,
      destination,
      metadata
    } = req.body;

    if (!request_id || !request_id.trim()) {
      return res.status(400).json({
        success: false,
        error_code: "ERR-VALIDATION-002",
        message: "request_id is invalid or empty"
      });
    }

    if (
      !source_type ||
      !workflow_id ||
      !content ||
      !Array.isArray(destination)
    ) {
      return res.status(400).json({
        success: false,
        error_code: "ERR-VALIDATION-001",
        message: "Required fields are missing"
      });
    }
    const gasUrl = process.env.GAS_WEBAPP_URL;

    if (!gasUrl) {
      throw new Error("GAS_WEBAPP_URL is not configured");
    }

    console.log("Ocean received:", request_id);
    console.log("Sending to GAS:", gasUrl);

    const gasResponse = await fetch(gasUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        request_id,
        source_type,
        workflow_id,
        content,
        destination,
        metadata,

        // Sky Data側の既存doPost()でも読める形にする
        text: content,
        message: content
      })
    });

    const gasResponseText = await gasResponse.text();

    console.log("GAS status:", gasResponse.status);
    console.log("GAS response:", gasResponseText);

    if (!gasResponse.ok) {
      throw new Error(
        `GAS forwarding failed: ${gasResponse.status} ${gasResponseText}`
      );
    }
    return res.status(200).json({
      success: true,
      request_id,
      status: "accepted"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error_code: "ERR-SERVER-000",
      message: error.message
    });
  }
});
app.post("/workflow/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "ファイルが選択されていません。"
      });
    }
const imageBuffer = fs.readFileSync(req.file.path);
const base64Image = imageBuffer.toString("base64");
const imageDataUrl =
  `data:${req.file.mimetype};base64,${base64Image}`;

const aiResponse = await openai.responses.create({
  model: "gpt-5",
  input: [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `
この画像を業務データとして解析してください。

次の項目を抽出してください。

- company_or_person
- location
- industry
- problem
- required_service
- urgency
- lead_rank
- image_summary

情報がない項目は「不明」にしてください。
urgencyは「高」「中」「低」「不明」のいずれか。
lead_rankは「A」「B」「C」のいずれか。

必ずJSONだけを返してください。
          `
        },
        {
          type: "input_image",
          image_url: imageDataUrl,
          detail: "high"
        }
      ]
    }
  ]
});

const analysis = parseAIResponse(aiResponse.output_text);
    return res.json({
  success: true,
  message: "ファイルを受け取り、AI解析が完了しました。",
  analysis: analysis,
  file: {
        originalName: req.file.originalname,
        savedName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size
      }
    });
  } catch (error) {
    console.error("ファイル受信エラー:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.post("/workflow", async (req, res) => {
  const startedAt = Date.now();
  const text = req.body?.text?.trim();

  if (!text) {
    return res.status(400).json({
      success: false,
      error_code: "INPUT-001",
      error: "文章を入力してください。"
    });
  }

  try {
    // ====================================
    // 1. OpenAIで文章を解析
    // ====================================

    const response = await openai.responses.create({
      model: "gpt-5.5",

      instructions: `
あなたは営業見込み客の情報を整理するAIです。
入力文章から、次の項目を抽出してください。

- company_or_person
- location
- industry
- problem
- required_service
- urgency
- lead_rank

必ずJSONだけを返してください。
説明文やMarkdownは返さないでください。

情報がない項目は「不明」にしてください。
urgencyは「高」「中」「低」「不明」のいずれかにしてください。
lead_rankは「A」「B」「C」のいずれかにしてください。

返却形式：

{
  "company_or_person": "",
  "location": "",
  "industry": "",
  "problem": "",
  "required_service": "",
  "urgency": "",
  "lead_rank": ""
}
`,

      input: text
    });

    const result = parseAIResponse(response.output_text);

    // ====================================
    // 2. ローカルJSONへ一時保存
    // ====================================

    const savedData = {
      id: Date.now(),
      created_at: new Date().toISOString(),
      original_text: text,
      data: result
    };

    const fileName = `workflow-${savedData.id}.json`;
    const filePath = path.join(dataFolder, fileName);

    fs.writeFileSync(
      filePath,
      JSON.stringify(savedData, null, 2),
      "utf8"
    );

    // ====================================
    // 3. Google Sheetsへ送信
    // ====================================

    let sheetsSaved = false;
    let sheetsMessage = "Google Sheetsへの送信は行われていません。";

    const sheetsWebhookUrl =
      process.env.GOOGLE_SHEETS_WEBHOOK_URL;

    if (sheetsWebhookUrl) {
      try {
        const sheetsResponse = await fetch(
          sheetsWebhookUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(savedData)
          }
        );

        const responseText = await sheetsResponse.text();

        let sheetsResult;

        try {
          sheetsResult = JSON.parse(responseText);
        } catch {
          sheetsResult = {
            success: sheetsResponse.ok,
            message: responseText
          };
        }

        if (!sheetsResponse.ok) {
          throw new Error(
            sheetsResult.error ||
              sheetsResult.message ||
              `Google Sheets HTTP Error: ${sheetsResponse.status}`
          );
        }

        sheetsSaved = sheetsResult.success === true;

        sheetsMessage =
          sheetsResult.message ||
          "Google Sheets saved";
      } catch (sheetsError) {
        console.error(
          "Google Sheets連携エラー:",
          sheetsError
        );

        sheetsSaved = false;
        sheetsMessage = sheetsError.message;

        saveErrorToTank({
          error: sheetsError,
          stage: "google_sheets",
          inputText: text,
          additionalData: {
            local_file: fileName,
            local_saved: true
          }
        });
      }
    } else {
      sheetsMessage =
        "GOOGLE_SHEETS_WEBHOOK_URLが設定されていません。";
    }

    // ====================================
    // 4. 成功結果を画面へ返す
    // ====================================

    const processingTimeMs = Date.now() - startedAt;

    return res.json({
      success: true,
      local_saved: true,
      file: fileName,
      sheets_saved: sheetsSaved,
      sheets_message: sheetsMessage,
      processing_time_ms: processingTimeMs,
      data: result
    });
  } catch (error) {
    // ====================================
    // 5. 重大エラーをエラータンクへ保存
    // ====================================

    console.error("Workflow APIエラー:", error);

    const errorLog = saveErrorToTank({
      error,
      stage: "workflow",
      inputText: text
    });

    return res.status(500).json({
      success: false,
      error_id: errorLog.errorId,
      error_saved: errorLog.saved,
      error_file: errorLog.fileName,
      error: error.message
    });
  }
});
// ========================================
// 賞味期限警告API
// Google Sheetsのテストシートを読み、
// 危険な商品だけを画面へ返す
// ========================================

app.get("/api/expiry-alerts", async (req, res) => {
  const startedAt = Date.now();

  try {
    const sheetsWebhookUrl =
      process.env.GOOGLE_SHEETS_WEBHOOK_URL;

    if (!sheetsWebhookUrl) {
      return res.status(500).json({
        success: false,
        error_code: "SHEETS-001",
        error:
          "GOOGLE_SHEETS_WEBHOOK_URLが設定されていません。"
      });
    }

    // URLの後ろに、読み取り命令とシート名を付ける
    const readUrl = new URL(sheetsWebhookUrl);

    readUrl.searchParams.set("action", "readExpiry");
    readUrl.searchParams.set(
      "sheet",
      req.query.sheet || "テスト"
    );

    const sheetsResponse = await fetch(readUrl);

    const responseText = await sheetsResponse.text();

    let sheetsResult;

    try {
      sheetsResult = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Google SheetsからJSON以外が返されました: ${responseText}`
      );
    }

    if (!sheetsResponse.ok) {
      throw new Error(
        sheetsResult.error ||
          `Google Sheets HTTP Error: ${sheetsResponse.status}`
      );
    }

    if (sheetsResult.success !== true) {
      throw new Error(
        sheetsResult.error ||
          "Google Sheetsの読み取りに失敗しました。"
      );
    }

    const products = Array.isArray(sheetsResult.products)
      ? sheetsResult.products
      : [];

    const now = new Date();

    // 時刻の差で日数がずれないように、
    // 今日の0時へそろえる
    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );

    const alertDays = Number(
      req.query.days || 30
    );

    const processedProducts = products
      .map((product) => {
        const expiryDate = new Date(product.expiry_date);

        if (Number.isNaN(expiryDate.getTime())) {
          return {
            ...product,
            days_remaining: null,
            alert_level: "日付エラー"
          };
        }

        const expiry = new Date(
          expiryDate.getFullYear(),
          expiryDate.getMonth(),
          expiryDate.getDate()
        );

        const differenceMs =
          expiry.getTime() - today.getTime();

        const daysRemaining = Math.ceil(
          differenceMs / (1000 * 60 * 60 * 24)
        );

        let alertLevel = "安全";

        if (daysRemaining < 0) {
          alertLevel = "期限切れ";
        } else if (daysRemaining <= 7) {
          alertLevel = "至急";
        } else if (daysRemaining <= alertDays) {
          alertLevel = "注意";
        }

        return {
          ...product,
          days_remaining: daysRemaining,
          alert_level: alertLevel
        };
      })
      // 日付エラー・期限切れ・30日以内だけを表示
      .filter((product) => {
        return (
          product.alert_level === "日付エラー" ||
          product.days_remaining <= alertDays
        );
      })
      // 賞味期限が近い順
      .sort((a, b) => {
        if (a.days_remaining === null) return -1;
        if (b.days_remaining === null) return 1;

        return a.days_remaining - b.days_remaining;
      });

    return res.json({
      success: true,
      sheet: req.query.sheet || "テスト",
      alert_days: alertDays,
      alert_count: processedProducts.length,
      processing_time_ms: Date.now() - startedAt,
      alerts: processedProducts
    });
  } catch (error) {
    console.error("賞味期限警告APIエラー:", error);

    const errorLog = saveErrorToTank({
      error,
      stage: "expiry_alerts",
      inputText: `sheet=${req.query.sheet || "テスト"}`,
      additionalData: {
        alert_days: req.query.days || 30
      }
    });

    return res.status(500).json({
      success: false,
      error_id: errorLog.errorId,
      error_saved: errorLog.saved,
      error_file: errorLog.fileName,
      error: error.message
    });
  }
});
// ========================================
// サーバー起動
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});