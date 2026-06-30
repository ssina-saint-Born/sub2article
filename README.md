کاملاً حق با شماست، یکجا و آماده‌اش کردم که بدون دردسر مستقیم کپی‌پیست کنید.

چون می‌خواهید مستقیماً داخل خود سایت گیت‌هاب بنویسید (با زدن دکمه **Add file** و بعد **Create new file** و گذاشتن نام **`README.md`**)، کل متن زیر را از ابتدا تا انتها یکجا کپی کنید و در ادیتور گیت‌هاب قرار دهید. نام پروژه را هم دقیقاً به `sub2article` تغییر دادم:

```markdown
# 🎬 sub2article

[English](#english) | [فارسی](#فارسی)

---

## English

An advanced, production-ready desktop application built with Electron and React. **sub2article** automatically processes, structures, and transforms video/audio subtitle files (`.srt`) or image text via OCR into high-quality, structured academic articles, study notes, or SEO-optimized blog posts using state-of-the-art AI models.

### ✨ Key Features
* **AI-Powered Subtitle Transformation:** Convert raw timeline subtitles into beautifully formatted summaries, lecture notes, or articles.
* **Image OCR Extractor:** Integrated Optical Character Recognition (OCR) to extract text content directly from screenshots and images.
* **Custom AI Providers:** Supports OpenAI-compatible custom endpoints (like AvalAI) and OpenRouter (allowing access to GPT, Claude, Gemini, and open-source models).
* **Local System Logs:** Real-time system console embedded inside the UI to monitor API connections and processing logs.
* **Modern Frameless UI:** Crafted with React, TailwindCSS, and shadcn/ui components for a premium dark-themed user experience.

### 🚀 Tech Stack
* **Frontend:** React, Vite, Tailwind CSS
* **Desktop Shell:** Electron
* **State/Logging Management:** React Context API (`LogContext`)

### 📦 Installation & Development

To run this project locally in development mode:

```bash
# 1. Clone the repository
git clone [https://github.com/ssina-saint-Born/sub2article.git](https://github.com/ssina-saint-Born/sub2article.git)

# 2. Navigate to the project directory
cd sub2article

# 3. Install required dependencies
npm install

# 4. Run the application in Electron development environment
npm run electron:dev

```

To package and compile the standalone production Windows installer (`.exe`):

```bash
npm run electron:build

```

---

## فارسی

یک نرم‌افزار دسکتاپ پیشرفته و حرفه‌ای توسعه‌یافته با **Electron** و **React**. برنامه **sub2article** به صورت هوشمند فایل‌های زیرنویس (`.srt`) یا متن‌های استخراج‌شده از تصاویر (OCR) را پردازش کرده و آن‌ها را به مقالات علمی، جزوه‌های درسی ساختاریافته یا پست‌های بلاگ بهینه‌شده برای سئو (SEO) تبدیل می‌کند.

### ✨ ویژگی‌های کلیدی

* **تبدیل هوشمند زیرنویس:** تبدیل زیرنویس‌های خام و زمان‌بندی‌شده ویدیوها به مقالات و جزوات خوانا و دسته‌بندی شده.
* **استخراج‌کننده متنی تصاویر (OCR):** سیستم داخلی شناسایی متنی برای استخراج مستقیم کلمات از روی عکس‌ها و اسکرین‌شات‌ها.
* **پشتیبانی از ارایه‌دهندگان مختلف AI:** قابلیت اتصال به پلتفرم‌های سازگار با OpenAI (مانند سرویس‌دهنده ایرانی AvalAI) و پلتفرم جهانی OpenRouter (دسترسی به آخرین مدل‌های Claude ،GPT و Gemini).
* **کنسول سیستمی داخلی:** نمایش زنده لاگ‌ها و وضعیت اتصال به APIها مستقیماً در پایین محیط نرم‌افزار.
* **رابط کاربری مدرن Frameless:** طراحی بی‌نقص محیط کاربری با تم تاریک (Dark Mode) با استفاده از Tailwind CSS.

### 🚀 تکنولوژی‌های استفاده شده

* **فرانت‌اند:** React, Vite, Tailwind CSS
* **پوسته دسکتاپ:** Electron
* **مدیریت وضعیت و لاگ‌ها:** React Context API

### 📦 راه اندازی و توسعه

برای اجرای پروژه در حالت توسعه بر روی سیستم خود:

```bash
# ۱. کلون کردن مخزن پروژه
git clone [https://github.com/ssina-saint-Born/sub2article.git](https://github.com/ssina-saint-Born/sub2article.git)

# ۲. ورود به پوشه پروژه
cd sub2article

# ۳. نصب پکیج‌ها و نیازمندی‌ها
npm install

# ۴. اجرای برنامه در حالت توسعه الکتورن
npm run electron:dev

```

برای خروجی گرفتن و ساخت فایل نصبی ویندوز (`.exe`):

```bash
npm run electron:build

```

```

