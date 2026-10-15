// Binary Prop Firm - One-Click Auto Deployment Script
// Pushes local code to GitHub and triggers the live server webhook to auto-pull & reload.

const { execSync } = require('child_process');
const https = require('https');

const DEPLOY_SECRET = process.env.DEPLOY_SECRET || 'bpf_deploy_master_key_ajhar1_2026';
const LIVE_URL = 'https://binarypropfirm.com/api/system/auto-deploy?secret=' + encodeURIComponent(DEPLOY_SECRET);

const commitMsg = process.argv.slice(2).join(' ') || `chore: auto-deploy updates at ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`;

console.log('=======================================================');
console.log('🚀 BINARY PROP FIRM — ONE-CLICK LIVE AUTO DEPLOYMENT');
console.log('=======================================================');
console.log(`📝 Commit Message: "${commitMsg}"\n`);

try {
  // 1. Stage changes (respecting .gitignore, protecting data/users.json etc.)
  console.log('📦 Step 1: Staging changes...');
  execSync('git add -A', { stdio: 'inherit' });

  // 2. Commit
  console.log('💾 Step 2: Committing changes...');
  try {
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  } catch (commitErr) {
    console.log('ℹ️ No new uncommitted changes found. Proceeding to push & deploy...');
  }

  // 3. Push to GitHub origin main
  console.log('⬆️ Step 3: Pushing to GitHub (origin/main)...');
  execSync('git push origin main', { stdio: 'inherit' });
  console.log('✅ Pushed to GitHub successfully!\n');

  // 4. Trigger Webhook on Live Server
  console.log(`🌐 Step 4: Triggering auto-deploy on live server (https://binarypropfirm.com)...`);
  
  const req = https.get(LIVE_URL, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.success) {
          console.log('\n=======================================================');
          console.log('🎉 SUCCESS: LIVE WEBSITE UPDATED SUCCESSFULLY!');
          console.log('=======================================================');
          console.log(`Output from live server:\n${json.gitOutput || json.message}`);
          console.log('\nYour live website is now running the latest code!');
        } else {
          console.warn('\n⚠️ Live Server Notice:', json.message || data);
        }
      } catch (parseErr) {
        if (res.statusCode === 404) {
          console.log('\n📌 FIRST-TIME ACTIVATION NOTICE:');
          console.log('The live server has not loaded the auto-deploy route yet.');
          console.log('Please run this command ONCE on your live server terminal:');
          console.log('👉  git pull origin main && pm2 restart all');
          console.log('After doing this once, all future updates will be 100% automated from here!');
        } else {
          console.log(`Server responded with status ${res.statusCode}:`, data);
        }
      }
    });
  });

  req.on('error', (err) => {
    console.warn('\n⚠️ Could not reach live server webhook directly:', err.message);
    console.log('Your code is already safe and pushed to GitHub main branch.');
  });

  req.setTimeout(15000, () => {
    req.destroy();
    console.log('\n⚠️ Request to live server timed out (server might already be restarting).');
  });

} catch (err) {
  console.error('\n❌ Deployment failed:', err.message);
  process.exit(1);
}
