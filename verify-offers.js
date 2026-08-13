const t = async () => {
  const html = await (await fetch('http://localhost:3000/offers')).text();
  const checks = {
    'Offers page serves': html.includes('page-offers'),
    'Offers nav link': html.includes('href="/offers"'),
    'Offers content': html.includes('Special Offers'),
    'Go back home': html.includes('showPage'),
    'Menu nav link': html.includes('href="/menu"'),
    'Reviews nav link': html.includes('data-page="reviews"'),
    'Contact nav link': html.includes('onclick="goToContact"'),
    'Home nav link': html.includes('href="/"')
  };
  console.log('=== RUNTIME CHECKS ===');
  let pass = 0, fail = 0;
  Object.entries(checks).forEach(([k, v]) => {
    console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
    v ? pass++ : fail++;
  });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
};
t().catch(e => { console.error('ERROR:', e.message); process.exit(1); });