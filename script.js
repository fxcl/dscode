const fs = require('fs');
const path = require('path');
const srcDir = '/Users/vec/workspace/js/ide/dscode/feynman/prompts/';
const destDir = '/Users/vec/workspace/js/ide/dscode/prompts/';
const files = ['audit.md', 'deepresearch.md', 'compare.md', 'lit.md', 'review.md', 'summarize.md', 'replicate.md'];
for (const file of files) {
  let content = fs.readFileSync(path.join(srcDir, file), 'utf8');
  content = content.replace(/feynman/gi, (match) => {
    if (match === 'feynman') return 'dscode';
    if (match === 'Feynman') return 'DSCode';
    if (match === 'FEYNMAN') return 'DSCODE';
    return 'dscode';
  });
  fs.writeFileSync(path.join(destDir, file), content);
}
console.log('Done');
