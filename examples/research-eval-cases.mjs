// Expected labels are reviewer-authored, independent of the workflow and model.
// They are never included in model state. Fictional cases, not a benchmark.
export const evidenceCases = [
  { id: 'direct', question: 'Can non-developers edit documentation in the repository?',
    text: 'During our fictional trial, four non-developers edited documentation through the browser and submitted changes without using a terminal.',
    keep: true, reason: 'An observed editing trial directly addresses access.' },
  { id: 'contrary', question: 'Will moving documentation to the repository improve search for synonyms?',
    text: 'In our fictional search trial, the repository found exact words but missed synonyms that the wiki found. Moving would reduce synonym coverage in this trial.',
    keep: true, reason: 'Evidence against the proposed benefit must still be retained.' },
  { id: 'irrelevant', question: 'Can non-developers edit documentation in the repository?',
    text: 'The fictional office cafeteria extended its Friday opening hours.',
    keep: false, reason: 'This says nothing about documentation editing.' },
  { id: 'topical', question: 'Can non-developers edit documentation in the repository?',
    text: 'The fictional repository documentation homepage now displays a green logo.',
    keep: false, reason: 'Topic overlap supplies no answer about editing.' },
  { id: 'promotion', question: 'Will moving documentation to the repository improve review quality?',
    text: 'Transform your reviews forever! Our revolutionary repository documentation product makes every team amazing.',
    keep: false, reason: 'Unsupported promotional language is not review evidence.' },
  { id: 'insufficient', question: 'Can non-developers edit documentation without administrator access?',
    text: 'The fictional guide contains a heading called "Editing permissions". Its body and permission settings were not supplied.',
    keep: false, reason: 'A heading does not establish who can edit.' },
];
