// Vercel 서버리스 함수: POST /api/generate
// 환경변수: LIBRARY_API_KEY (공공데이터포털 서비스키), GEMINI_API_KEY (Gemini 키)
// 데이터: 국립중앙도서관_사서추천도서(국립어린이청소년도서관) - odcloud 15151124

const LIB_URL =
  "https://api.odcloud.kr/api/15151124/v1/uddi:8d9836b3-d781-4047-af85-f3b939272ef7";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PER_PAGE = 1000;
const MAX_PAGES = 20;                  // 목록 페이지 수 상한(너무 오래 걸리지 않게)
const CACHE_MS = 6 * 60 * 60 * 1000;   // 목록은 6시간 동안 서버에 보관
const MAX_RESULTS = 6;
const MIN_TERM_LEN = 2;                // AI가 준 단어는 2글자 이상만 사용

let cache = { books: null, at: 0 };

// ---------- 공통 유틸 ----------
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(text) {
  return String(text == null ? "" : text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Encoding 키(%2B 등)를 붙여넣어도 동작하도록 한 번 풀어줌
function normalizeKey(key) {
  const k = String(key || "").trim();
  if (/%[0-9A-Fa-f]{2}/.test(k)) {
    try { return decodeURIComponent(k); } catch (e) { return k; }
  }
  return k;
}

function extractIsbn13(raw) {
  const digits = String(raw || "").replace(/[-\s]/g, "");
  const m = digits.match(/97[89]\d{10}/);
  return m ? m[0] : "";
}

function shorten(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---------- 도서관 API ----------
async function fetchPage(page, serviceKey) {
  const qs = new URLSearchParams({
    page: String(page),
    perPage: String(PER_PAGE),
    returnType: "JSON",
    serviceKey
  });
  const res = await fetchWithTimeout(`${LIB_URL}?${qs}`, {}, 9000);
  if (!res.ok) {
    const err = new Error("library http " + res.status);
    err.status = res.status; // 401·403이면 인증 문제
    throw err;
  }
  const json = await res.json();
  if (!Array.isArray(json.data)) {
    // 응답 모양이 다를 때: 메시지에 인증 관련 말이 있을 때만 인증 오류로 봄
    const msg = String(json.msg || json.message || "unexpected");
    const err = new Error("library response: " + msg);
    err.status = /인증|key|키|unauthor|forbidden/i.test(msg) ? 401 : 502;
    throw err;
  }
  return json;
}

function normalizeRow(row) {
  const title = cleanText(row["제목"]);
  if (!title) return null;
  const isbn = extractIsbn13(row["국제표준도서번호(ISBN)"]);
  return {
    title,
    author: cleanText(row["저자"]),
    publisher: cleanText(row["발행처"]),
    summary: cleanText(row["내용"]),
    theme: cleanText(row["테마명"]),
    subject: cleanText(row["주제"]),
    target: cleanText(row["대상"]),
    cover: isbn
      ? `https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/${isbn}.jpg`
      : "",
    key: isbn || title + "|" + cleanText(row["저자"])
  };
}

async function loadBooks(serviceKey) {
  if (cache.books && Date.now() - cache.at < CACHE_MS) return cache.books;

  // 첫 페이지는 꼭 성공해야 함(실패하면 인증·연결 문제)
  const first = await fetchPage(1, serviceKey);
  let rows = first.data.slice();

  const total = Number(first.totalCount) || rows.length;
  const pages = Math.min(Math.ceil(total / PER_PAGE), MAX_PAGES);
  let failedPages = 0;

  if (pages > 1) {
    // 나머지 페이지는 일부가 실패해도 받은 것만으로 계속 진행
    const rest = await Promise.allSettled(
      Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2, serviceKey))
    );
    rest.forEach((r) => {
      if (r.status === "fulfilled") rows = rows.concat(r.value.data);
      else failedPages += 1;
    });
    if (failedPages) console.error(`library: ${failedPages}개 페이지를 받지 못함`);
  }

  // 정리 + 같은 책(ISBN 또는 제목+저자) 중복 제거
  const seen = new Set();
  const books = [];
  rows.forEach((r) => {
    const b = normalizeRow(r);
    if (!b || seen.has(b.key)) return;
    seen.add(b.key);
    books.push(b);
  });

  // 빠진 페이지가 있으면 보관하지 않고 다음 요청 때 다시 받음
  if (!failedPages) cache = { books, at: Date.now() };
  return books;
}

// ---------- Gemini: 키워드와 가까운 단어 만들기 ----------
// 결과: { terms: [...], error: "" }  — error가 있으면 AI 없이 검색한 것
async function expandKeyword(keyword, apiKey) {
  if (!apiKey) return { terms: [], error: "GEMINI_API_KEY 없음" };
  try {
    const prompt =
      `그림책 검색을 돕는 사서입니다. 키워드 "${keyword}"와 뜻이 가깝거나 ` +
      `그림책 제목·주제에 자주 쓰이는 한국어 단어를 8개 이내로 알려주세요. ` +
      `한 글자 단어는 빼고, 반드시 {"terms":["단어1","단어2"]} 형식의 JSON만 출력하세요.`;

    const res = await fetchWithTimeout(
      GEMINI_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: "application/json"
          }
        })
      },
      7000
    );
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error("Gemini error:", res.status, detail);
      return { terms: [], error: "Gemini 오류 " + res.status };
    }
    const data = await res.json();
    const parts =
      (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");
    const parsed = JSON.parse(text.replace(/```json|```/gi, "").trim());
    const terms = (Array.isArray(parsed.terms) ? parsed.terms : [])
      .filter((t) => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length >= MIN_TERM_LEN && t.length <= 12)
      .filter((t) => t.toLowerCase() !== keyword.toLowerCase())
      .slice(0, 8);
    return { terms, error: terms.length ? "" : "AI가 단어를 주지 않음" };
  } catch (e) {
    console.error("Gemini expand failed:", e.message);
    const reason = e.name === "AbortError" ? "Gemini 응답 시간 초과" : "Gemini 응답 처리 실패";
    return { terms: [], error: reason }; // Gemini가 실패해도 키워드만으로 검색은 계속함
  }
}

// ---------- 검색 점수 계산 ----------
function searchBooks(books, keyword, extraTerms) {
  const kw = keyword.toLowerCase();
  const terms = [{ t: kw, w: 3 }];
  keyword.split(/\s+/).forEach((p) => {
    if (p.length >= 2 && p.toLowerCase() !== kw) {
      terms.push({ t: p.toLowerCase(), w: 2 });
    }
  });
  extraTerms.forEach((t) => terms.push({ t: t.toLowerCase(), w: 1 }));

  const scored = [];
  books.forEach((b) => {
    const title = b.title.toLowerCase();
    const tag = (b.theme + " " + b.subject).toLowerCase();
    const author = b.author.toLowerCase();
    const body = b.summary.toLowerCase();

    let score = 0;
    terms.forEach(({ t, w }) => {
      if (title.includes(t)) score += 5 * w;
      if (tag.includes(t)) score += 3 * w;
      if (body.includes(t)) score += 2 * w;
      if (author.includes(t)) score += 1 * w;
    });
    if (score === 0) return;

    // 그림책 위주로 보이도록 유아·초등 대상 책에 작은 가산점
    if (/유아|초등/.test(b.target)) score += 1;
    scored.push({ b, score });
  });

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, MAX_RESULTS).map(({ b }) => ({
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    summary: shorten(b.summary, 280),
    cover: b.cover
  }));
}

// ---------- 핸들러 ----------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 사용할 수 있어요." });
  }

  const libKey = normalizeKey(process.env.LIBRARY_API_KEY);
  if (!libKey) {
    return res
      .status(500)
      .json({ error: "서버에 LIBRARY_API_KEY 환경변수가 설정되지 않았어요." });
  }
  const geminiKey = process.env.GEMINI_API_KEY || "";

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const keyword = String((body && body.keyword) || "").trim().slice(0, 50);
  if (!keyword) {
    return res.status(400).json({ error: "키워드를 입력해 주세요." });
  }

  try {
    // 도서관 목록 불러오기와 Gemini 단어 확장을 동시에 진행
    const [books, ai] = await Promise.all([
      loadBooks(libKey),
      expandKeyword(keyword, geminiKey)
    ]);
    return res.status(200).json({
      books: searchBooks(books, keyword, ai.terms),
      aiTerms: ai.terms,          // AI가 넓혀 준 단어(비어 있으면 AI 없이 검색)
      aiUsed: ai.terms.length > 0,
      aiNote: ai.error            // AI를 못 쓴 이유(화면 안내용, 키 값은 들어가지 않음)
    });
  } catch (err) {
    console.error("generate error:", err.message);
    if (err.status === 401 || err.status === 403) {
      return res.status(502).json({
        error: "도서관 API 인증에 실패했어요. LIBRARY_API_KEY를 확인해 주세요. (방금 승인된 키는 반영에 시간이 걸릴 수 있어요)"
      });
    }
    return res.status(502).json({
      error: "도서관 API에서 자료를 가져오지 못했어요. 잠시 후 다시 시도해 주세요."
    });
  }
};
