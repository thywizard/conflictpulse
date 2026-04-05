// ============================================================
//  ConflictPulse — Complete Backend Server
//  Single file: DB models + RSS + Gemini + Cloudinary + Routes
// ============================================================

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const RSSParser = require("rss-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================
//  MIDDLEWARE
// ============================================================
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(morgan("dev"));
// REPLACE WITH THIS:
app.use(cors({
  origin: function(origin, callback) {
    // Allow all origins
    callback(null, true);
  },
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — protect API from abuse
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use("/api/", limiter);

// ============================================================
//  CLOUDINARY CONFIG
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer storage → Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: "conflictpulse", allowed_formats: ["jpg","jpeg","png","webp"] }
});
const upload = multer({ storage });

// ============================================================
//  GEMINI AI CONFIG
// ============================================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// ============================================================
//  RSS FEEDS
// ============================================================
const RSS_FEEDS = [
  { url: "http://feeds.bbci.co.uk/news/world/rss.xml",         source: "BBC" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml",          source: "Al Jazeera" },
  { url: "https://feeds.reuters.com/reuters/worldNews",         source: "Reuters" },
  { url: "https://rss.dw.com/xml/rss-en-world",                source: "DW" },
  { url: "https://www.france24.com/en/rss",                    source: "France 24" },
  { url: "https://feeds.skynews.com/feeds/rss/world.xml",      source: "Sky News" },
  { url: "https://theintercept.com/feed/?rss",                 source: "The Intercept" },
  { url: "https://foreignpolicy.com/feed/",                    source: "Foreign Policy" },
];

// ============================================================
//  MONGODB CONNECTION
// ============================================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ============================================================
//  DATABASE MODELS
// ============================================================

// --- Article Model ---
const articleSchema = new mongoose.Schema({
  title:         { type: String, required: true },
  summary:       { type: String, default: "" },
  url:           { type: String, required: true, unique: true },
  imageUrl:      { type: String, default: "" },
  source:        { type: String, default: "Unknown" },
  region:        { type: String, default: "Global",
                   enum: ["Middle East","Europe","Africa","Asia",
                          "Americas","Global","Russia & CIS","South Asia"] },
  topic:         { type: String, default: "Other",
                   enum: ["Airstrikes","Ground Combat","Ceasefire","Sanctions",
                          "Diplomacy","Casualties","Weapons","Protests",
                          "War Crimes","Nuclear","Cyber","Other"] },
  importance:    { type: String, default: "medium",
                   enum: ["breaking","high","medium","low"] },
  conflictScore: { type: Number, default: 5, min: 1, max: 10 },
  entities:      [String],
  isBreaking:    { type: Boolean, default: false },
  isManual:      { type: Boolean, default: false },
  likes:         { type: Number, default: 0 },
  views:         { type: Number, default: 0 },
  shares:        { type: Number, default: 0 },
  publishedAt:   { type: Date, default: Date.now },
  fetchedAt:     { type: Date, default: Date.now },
  createdAt:     { type: Date, default: Date.now },
}, { timestamps: true });

// TTL index: auto-delete articles older than 30 days
articleSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 2592000 });
articleSchema.index({ title: "text", summary: "text", entities: "text" });
const Article = mongoose.model("Article", articleSchema);

// --- Visit / Analytics Model ---
const visitSchema = new mongoose.Schema({
  visitorId:  { type: String, required: true },
  page:       { type: String, default: "/" },
  articleId:  { type: mongoose.Schema.Types.ObjectId, ref: "Article", default: null },
  country:    { type: String, default: "Unknown" },
  device:     { type: String, default: "desktop",
                enum: ["desktop","mobile","tablet"] },
  referrer:   { type: String, default: "direct" },
  duration:   { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
});
visitSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days
const Visit = mongoose.model("Visit", visitSchema);

// --- Fetch Log Model ---
const fetchLogSchema = new mongoose.Schema({
  triggeredBy:    { type: String, default: "cron" },
  articlesFound:  { type: Number, default: 0 },
  articlesAdded:  { type: Number, default: 0 },
  duplicates:     { type: Number, default: 0 },
  failed:         { type: Number, default: 0 },
  duration:       { type: Number, default: 0 },
  status:         { type: String, default: "success", enum: ["success","partial","failed"] },
  error:          { type: String, default: "" },
  createdAt:      { type: Date, default: Date.now },
});
const FetchLog = mongoose.model("FetchLog", fetchLogSchema);

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
const protect = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Cron job secret protection
const cronProtect = (req, res, next) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET && secret !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: "Unauthorized cron trigger" });
  }
  next();
};

// ============================================================
//  GEMINI AI SERVICE
// ============================================================

// ============================================================
async function processWithGemini(articles) {
  if (!articles.length) return [];

const prompt = `You are an expert war and conflict news analyst with deep knowledge of geopolitics.

Analyze each article below and return ONLY a valid JSON array. No markdown, no explanation, no backticks. Raw JSON only.

For each return:
{
  "index": <number>,
  "summary": "<2-3 sentence factual summary focusing on WHO did WHAT, WHERE, and the impact>",
  "region": "<pick the MOST SPECIFIC match: Middle East|Europe|Africa|Asia|Americas|Global|Russia & CIS|South Asia>",
  "topic": "<pick the PRIMARY topic: Airstrikes|Ground Combat|Ceasefire|Sanctions|Diplomacy|Casualties|Weapons|Protests|War Crimes|Nuclear|Cyber|Other>",
  "importance": "<breaking|high|medium|low>",
  "conflictScore": <1-10>,
  "entities": ["country/group/person names mentioned"],
  "isDuplicate": <true|false>,
  "isConflictRelated": <true|false>
}

REGION RULES — be specific, not lazy:
- Any news about Iraq, Syria, Israel, Gaza, Lebanon, Yemen, Iran = "Middle East"
- Russia, Ukraine, Belarus, Moldova = "Russia & CIS"  
- India, Pakistan, Afghanistan, Bangladesh = "South Asia"
- China, Japan, Korea, Southeast Asia = "Asia"
- Any African country = "Africa"
- US, Canada, Latin America = "Americas"
- Only use "Global" if it genuinely involves 3+ continents

TOPIC RULES — pick the dominant action:
- Bombs, missiles, drone strikes = "Airstrikes"
- Troops, tanks, invasions = "Ground Combat"  
- Death tolls, injury counts = "Casualties"
- Peace talks, negotiations = "Diplomacy"
- Trade restrictions, asset freezes = "Sanctions"
- Weapons deals, arms transfers = "Weapons"
- Civilian protests, riots = "Protests"
- Torture, civilian targeting = "War Crimes"
- Nuclear weapons/threats = "Nuclear"
- Hacking, cyber attacks = "Cyber"
- Ceasefire agreements = "Ceasefire"

IMPORTANCE RULES:
- breaking: active ongoing attack, mass casualty event RIGHT NOW
- high: major development in an active war zone
- medium: diplomatic development, sanctions, regional tension
- low: background analysis, historical context

CONFLICT SCORE:
- 1-3: political tension, sanctions, diplomacy
- 4-6: active skirmishes, ongoing conflict
- 7-9: major war event, large casualties
- 10: nuclear/WMD use, mass atrocity

isConflictRelated = true for: war, military ops, terrorism, sanctions, geopolitical crisis
isConflictRelated = false for: sports, entertainment, weather, economics unrelated to conflict

IMPORTANT: Use the article TITLE as the primary classification signal.
The title alone contains enough to determine region and topic.
NEVER default to "Global", "Other", or "medium" without a clear specific reason.
If the title mentions a country or region — use it. If it mentions an attack — it is Airstrikes or Ground Combat, not Other.

Articles:
${JSON.stringify(articles.map((a, i) => ({
  index: i,
  source: a.source || "",
  title: a.title || "",
  content: `${a.title}. ${(a.contentSnippet || a.content || "").substring(0, 800)}`
})))}`;
   try {
    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text().trim();
    // Strip markdown fences if present
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("Gemini processing error:", err.message);
    return [];
  }
}


// ============================================================
//  RSS FETCH SERVICE
// ============================================================
async function fetchAndProcessRSS(triggeredBy = "cron") {
  const startTime = Date.now();
  const parser = new RSSParser({
    timeout: 10000,
    headers: { "User-Agent": "ConflictPulse/1.0 RSS Aggregator" }
  });

  let allArticles = [];

  // Fetch all RSS feeds
  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 15).map(item => ({
        title:          item.title || "",
        url:            item.link || item.guid || "",
        contentSnippet: item.contentSnippet || item.summary || "",
        content:        item.content || "",
        imageUrl:       item.enclosure?.url ||
                        item["media:content"]?.["$"]?.url || "",
        source:         feed.source,
        publishedAt:    item.pubDate ? new Date(item.pubDate) : new Date(),
      }));
      allArticles = [...allArticles, ...items];
      console.log(`✅ Fetched ${items.length} from ${feed.source}`);
    } catch (err) {
      console.error(`❌ Failed to fetch ${feed.source}:`, err.message);
    }
  }

  if (!allArticles.length) {
    await FetchLog.create({ triggeredBy, status: "failed", error: "No articles fetched", duration: Date.now() - startTime });
    return { added: 0, total: 0 };
  }

  // Remove articles already in DB (by URL)
  const existingUrls = new Set(
    (await Article.find({}, "url").lean()).map(a => a.url)
  );
  const newArticles = allArticles.filter(a => a.url && !existingUrls.has(a.url));

  console.log(`📰 ${newArticles.length} new articles to process with Gemini`);

  if (!newArticles.length) {
    await FetchLog.create({ triggeredBy, articlesFound: allArticles.length, articlesAdded: 0, duplicates: allArticles.length - newArticles.length, duration: Date.now() - startTime });
    return { added: 0, total: allArticles.length };
  }

  // Process with Gemini in batches of 20
  const BATCH_SIZE = 20;
  let totalAdded = 0;

  for (let i = 0; i < newArticles.length; i += BATCH_SIZE) {
    const batch = newArticles.slice(i, i + BATCH_SIZE);
    const aiResults = await processWithGemini(batch);

    for (let j = 0; j < batch.length; j++) {
      const raw = batch[j];
      const ai = aiResults.find(r => r.index === j) || {};

      // Skip non-conflict or duplicates
      if (ai.isConflictRelated === false) continue;
      if (ai.isDuplicate === true) continue;
      if (!raw.url) continue;

      try {
        await Article.create({
          title:         raw.title,
          summary:       ai.summary || raw.contentSnippet?.substring(0, 300) || "",
          url:           raw.url,
          imageUrl:      raw.imageUrl || "",
          source:        raw.source,
          region:        ai.region || "Global",
          topic:         ai.topic || "Other",
          importance:    ai.importance || "medium",
          conflictScore: ai.conflictScore || 5,
          entities:      ai.entities || [],
          isBreaking:    ai.importance === "breaking",
          publishedAt:   raw.publishedAt,
          fetchedAt:     new Date(),
        });
        totalAdded++;
      } catch (err) {
        if (err.code !== 11000) // ignore duplicate key errors
          console.error("Save error:", err.message);
      }
    }

    // Respect Gemini rate limit between batches
    if (i + BATCH_SIZE < newArticles.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const logData = {
    triggeredBy,
    articlesFound:  allArticles.length,
    articlesAdded:  totalAdded,
    duplicates:     allArticles.length - newArticles.length,
    duration:       Date.now() - startTime,
    status:         "success"
  };
  await FetchLog.create(logData);
  console.log(`✅ Fetch complete. Added ${totalAdded} new articles.`);
  return { added: totalAdded, total: allArticles.length };
}

// ============================================================
//  PUBLIC ROUTES — NEWS
// ============================================================

// GET /api/news — Get articles with filters + pagination + search
app.get("/api/news", async (req, res) => {
  try {
    const {
      region, topic, importance, search,
      page = 1, limit = 20, sort = "latest"
    } = req.query;

    const query = {};
    if (region)     query.region = region;
    if (topic)      query.topic = topic;
    if (importance) query.importance = importance;
    if (search)     query.$text = { $search: search };

    const sortMap = {
      latest:  { publishedAt: -1 },
      oldest:  { publishedAt:  1 },
      views:   { views: -1 },
      score:   { conflictScore: -1 },
    };

    const [articles, total, breaking] = await Promise.all([
      Article.find(query)
        .sort(sortMap[sort] || sortMap.latest)
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Article.countDocuments(query),
      Article.find({ isBreaking: true })
        .sort({ publishedAt: -1 })
        .limit(5)
        .lean()
    ]);

    res.json({
      success: true,
      articles,
      breaking,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
        limit: Number(limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/:id — Single article
app.get("/api/news/:id", async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json({ success: true, article });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/:id/view — Track article view
app.post("/api/news/:id/view", async (req, res) => {
  try {
    await Article.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/:id/like — Like an article
app.post("/api/news/:id/like", async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(
      req.params.id,
      { $inc: { likes: 1 } },
      { new: true }
    );
    res.json({ success: true, likes: article.likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/:id/share — Track share
app.post("/api/news/:id/share", async (req, res) => {
  try {
    await Article.findByIdAndUpdate(req.params.id, { $inc: { shares: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/filters — Get available filter options
app.get("/api/filters", async (req, res) => {
  try {
    const [regions, topics] = await Promise.all([
      Article.distinct("region"),
      Article.distinct("topic"),
    ]);
    res.json({ success: true, regions, topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ANALYTICS TRACKING ROUTE (PUBLIC)
// ============================================================
app.post("/api/track", async (req, res) => {
  try {
    const { visitorId, page, articleId, device, referrer, duration } = req.body;
    await Visit.create({
      visitorId: visitorId || uuidv4(),
      page:      page || "/",
      articleId: articleId || null,
      device:    device || "desktop",
      referrer:  referrer || "direct",
      duration:  duration || 0,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(200).json({ success: false }); // fail silently
  }
});

// ============================================================
//  RSS FETCH TRIGGER ROUTE
// ============================================================
app.post("/api/fetch-news", cronProtect, async (req, res) => {
  try {
    console.log("🔄 RSS fetch triggered...");
    const result = await fetchAndProcessRSS(req.body.triggeredBy || "cron");
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN ROUTES
// ============================================================

// POST /api/admin/login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email !== process.env.ADMIN_EMAIL) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const valid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || "")
      || password === process.env.ADMIN_PASSWORD;
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { email, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats — Dashboard overview
app.get("/api/admin/stats", protect, async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.setHours(0,0,0,0));
    const week  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalArticles,
      breakingCount,
      todayArticles,
      weekArticles,
      byRegion,
      byTopic,
      byImportance,
      topViewed,
      topLiked,
      topShared,
      totalVisits,
      todayVisits,
      weekVisits,
      deviceBreakdown,
      referrerBreakdown,
      recentFetches,
      avgConflictScore,
    ] = await Promise.all([
      Article.countDocuments(),
      Article.countDocuments({ isBreaking: true }),
      Article.countDocuments({ createdAt: { $gte: today } }),
      Article.countDocuments({ createdAt: { $gte: week } }),
      Article.aggregate([{ $group: { _id: "$region", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Article.aggregate([{ $group: { _id: "$topic", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Article.aggregate([{ $group: { _id: "$importance", count: { $sum: 1 } } }]),
      Article.find().sort({ views: -1 }).limit(10).select("title views source region publishedAt imageUrl").lean(),
      Article.find().sort({ likes: -1 }).limit(10).select("title likes source region publishedAt imageUrl").lean(),
      Article.find().sort({ shares: -1 }).limit(10).select("title shares source region publishedAt imageUrl").lean(),
      Visit.countDocuments(),
      Visit.countDocuments({ createdAt: { $gte: today } }),
      Visit.countDocuments({ createdAt: { $gte: week } }),
      Visit.aggregate([{ $group: { _id: "$device", count: { $sum: 1 } } }]),
      Visit.aggregate([{ $group: { _id: "$referrer", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }]),
      FetchLog.find().sort({ createdAt: -1 }).limit(10).lean(),
      Article.aggregate([{ $group: { _id: null, avg: { $avg: "$conflictScore" } } }]),
    ]);

    // Unique visitors
    const uniqueTotal = await Visit.distinct("visitorId").then(v => v.length);
    const uniqueToday = await Visit.distinct("visitorId", { createdAt: { $gte: today } }).then(v => v.length);

    res.json({
      success: true,
      articles: {
        total: totalArticles,
        breaking: breakingCount,
        today: todayArticles,
        thisWeek: weekArticles,
        byRegion,
        byTopic,
        byImportance,
        avgConflictScore: avgConflictScore[0]?.avg?.toFixed(1) || 0,
      },
      traffic: {
        totalVisits,
        todayVisits,
        weekVisits,
        uniqueTotal,
        uniqueToday,
        deviceBreakdown,
        referrerBreakdown,
      },
      topContent: {
        topViewed,
        topLiked,
        topShared,
      },
      fetchHistory: recentFetches,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/articles — All articles (paginated)
app.get("/api/admin/articles", protect, async (req, res) => {
  try {
    const { page = 1, limit = 30, region, topic, importance, search } = req.query;
    const query = {};
    if (region)     query.region = region;
    if (topic)      query.topic = topic;
    if (importance) query.importance = importance;
    if (search)     query.$text = { $search: search };

    const [articles, total] = await Promise.all([
      Article.find(query).sort({ createdAt: -1 })
        .skip((page - 1) * limit).limit(Number(limit)).lean(),
      Article.countDocuments(query)
    ]);
    res.json({ success: true, articles, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/articles — Create article manually
app.post("/api/admin/articles", protect, async (req, res) => {
  try {
    const article = await Article.create({ ...req.body, isManual: true });
    res.status(201).json({ success: true, article });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/admin/articles/:id — Update article
app.put("/api/admin/articles/:id", protect, async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json({ success: true, article });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/admin/articles/:id — Delete article
app.delete("/api/admin/articles/:id", protect, async (req, res) => {
  try {
    await Article.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Article deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/articles/bulk — Delete multiple articles
app.delete("/api/admin/articles/bulk", protect, async (req, res) => {
  try {
    const { ids } = req.body;
    await Article.deleteMany({ _id: { $in: ids } });
    res.json({ success: true, message: `${ids.length} articles deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/articles/:id/breaking — Toggle breaking news
app.put("/api/admin/articles/:id/breaking", protect, async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ error: "Article not found" });
    article.isBreaking = !article.isBreaking;
    article.importance = article.isBreaking ? "breaking" : "high";
    await article.save();
    res.json({ success: true, isBreaking: article.isBreaking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload — Upload image to Cloudinary
app.post("/api/admin/upload", protect, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    res.json({ success: true, imageUrl: req.file.path, publicId: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/fetch — Manual RSS trigger from admin
app.post("/api/admin/fetch", protect, async (req, res) => {
  try {
    const result = await fetchAndProcessRSS("admin");
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/fetch-logs — RSS fetch history
app.get("/api/admin/fetch-logs", protect, async (req, res) => {
  try {
    const logs = await FetchLog.find().sort({ createdAt: -1 }).limit(20).lean();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "🟢 ConflictPulse API is running",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ============================================================
//  START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 ConflictPulse server running on port ${PORT}`);
  console.log(`📊 Admin at: /api/admin/*`);
  console.log(`📰 News at:  /api/news`);
});
