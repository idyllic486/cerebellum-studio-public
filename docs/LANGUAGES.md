# Interface languages

English is the default and editorial source. Visitors choose English, 한국어, 日本語, 中文（台灣） or 中文（简体） using the language control in the header. The supported BCP47 tags are `en`, `ko`, `ja`, `zh-Hant-TW` and `zh-Hans-CN`.

## Behavior

A language selection changes the displayed interface without reloading the page. The explicit preference is stored under `cerebellum-studio.locale`; browser storage failure does not block switching. A fresh visitor starts in English regardless of browser language. If a translation file cannot load, the current working language stays active. Every translation asset is served from the same Site; source images and research records are not sent to a translation service.

The implementation updates text nodes and accessible labels while retaining DOM controls, selected File objects, input values, active views, review/approval records and camera state. `html.lang` reflects the applied language. Original option values are preserved independently of translated labels.

## Scientific meaning and preserved records

| Meaning | Korean | Japanese | Taiwan Traditional Chinese | Mainland Simplified Chinese |
| --- | --- | --- | --- | --- |
| Molecular layer (ML) | 분자층 | 分子層 | 分子層 | 分子层 |
| Granular layer (GL) | 과립층 | 顆粒層 | 顆粒層 | 颗粒层 |
| White matter (WM) | 백질 | 白質 | 白質 | 白质 |
| Review | 검토 | レビュー | 審查 | 审核 |
| Approved | 승인됨 | 承認済み | 已核准 | 已批准 |
| Unverified | 미검증 | 未検証 | 未驗證 | 未验证 |
| Hold-out validation | 가림 검증 | ホールドアウト検証 | 保留切片驗證 | 留出验证 |
| Open line | 열린 선 | 開いた線 | 開放線段 | 开放线段 |
| Point count | 점 개수 | 点の数 | 點數 | 点数 |

Observation, inference, review and approval remain distinct. Missing measurements are not represented as zero. Localization does not change the research scope, validate anatomical assignments or supply a trained model.

ROI geometry and observation labels are also distinct. Area ROIs support area and perimeter, open lines support path length, and points support annotation count. A PL label does not turn a line into a cell count or layer-thickness measurement. The option values and exported geometry kinds remain stable across languages. New onboarding describes the available manual/import workflow; it does not claim a supplied automatic Nissl model.

Original files, ROI and anatomical source names, user-authored notes, reviewer names, IDs, CSV headers/cells, schemas, units, numeric precision, exclusions, timestamps and fingerprints retain their recorded form. These source displays may contain English or other original languages intentionally. Technical downloadable documentation remains in its original language; English Markdown downloads are labelled accordingly. Native file-picker dialogs and browser-generated control text follow the browser/operating-system language. Machine-readable exports retain stable keys and source values. Human-readable section PNG captions follow the selected interface language.

## Maintenance

- `src/locales/en.json` is the reference catalog; `catalog-sources.json` records extraction context and is not distributed to the Site.
- Four locale JSON files contain matching source keys. Regional Chinese versions have independently worded translations, not automatic character substitution.
- `supplemental.json` holds additional interface strings and complete-message templates for all five languages. The presence of a translation is not evidence of native-speaker or domain review.
- `templates.json` defines bounded dynamic-message patterns. Original values in placeholders remain verbatim; only explicitly identified interface slots are translatable.
- `src/i18n.js` owns locale selection, text provenance, progressive updates and recovery. Scientific computation modules have no localization dependency.
- Mark new original-data DOM islands `translate="no"`. Do not concatenate a raw name into an unprotected translatable label. Use protected spans or explicit raw-capture templates.
- Do not run global substring translation on arbitrary user/source strings. Do not translate schema keys or saved research objects.

Run `node qa/check_i18n.cjs` against a current build and the full validation runner for a release. It exercises genuine controls, synthetic TIFF/ROI/CSV data and approved research records. Translation accuracy remains an editorial responsibility; software checks establish consistency and state preservation, not native-speaker or anatomical validation.

Critical manual-review, geometry-kind, file-selection and model-provenance messages must have explicit translations in every supported locale. The focused assertions in `qa/check_i18n.cjs` reject missing translations for these messages rather than accepting English fallback as a passing translation. General catalog capture still records other untranslated strings for review: source names, citations, units and user data need an explicit preservation decision, while missing application instructions need translations.

## Verification evidence

Use `qa/release-index.json` to identify the current executed validation run and its linked artifacts. A source edit or a newly written test is not a passing run. Language checks must use the build produced for the source revision being reviewed.

The earlier `qa/i18n-validation-run.json`, `qa/i18n-scientific-regression.json` and `qa/i18n-release.json` describe their historical runs. Their counts and fingerprints must not be presented as fresh evidence for later changes unless the current release index explicitly includes them. Neither historical nor current software checks replace native-speaker editorial review, assistive-technology task testing or independent biological validation.
