function generateNickname(first) {
  const suffixes = [
    "Slayer","Rider","Blade","Hunter","Ghost","Shadow","Strike","Storm",
    "Nova","Vortex","Fury","Drift","Rogue","Phantom","Wolf","Dragon",
    "Reaper","Flash","Venom","Spike","Burst"
  ];

  const modifiers = ["", "X", "Pro", "Ultra", "Neo", "Dark", "Night", "Zero", "Alpha", "Omega"];
  const numbers = ["", "07", "13", "99", "404", "777", "1337"];

  const suf  = suffixes[Math.floor(Math.random() * suffixes.length)];
  const mod  = modifiers[Math.floor(Math.random() * modifiers.length)];
  const num  = numbers[Math.floor(Math.random() * numbers.length)];

  return first + mod + suf + num;
}

