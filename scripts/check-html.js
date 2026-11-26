const fs = require('fs');
const vm = require('vm');
const files = ['friends.html', 'messages.html', 'collaboration.html', 'packager.html', 'my.html'];
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) throw new Error(file + ': no inline script found');
  scripts.forEach((match, index) => {
    try { new vm.Script(match[1], {filename: file + '#script' + index}); }
    catch (error) { console.error(file + ' script ' + index + ': ' + error.message); process.exitCode = 1; }
  });
  if (!process.exitCode) console.log(file + ': inline JavaScript syntax OK');
}
