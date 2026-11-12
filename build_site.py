#!/usr/bin/env python3
"""Deterministic static build from explicit inputs, never from an old dist tree."""
from pathlib import Path
import argparse
import hashlib
import html.parser as html_parser
import json
import os
import re
import shutil
import tempfile
import zipfile

R = Path(__file__).resolve().parent
PANELS = ['annotation', 'source', 'project', 'cohort', 'research', 'workspace', 'analysis',
          'study', 'science_tools', 'private_collaboration', 'methods', 'lab', 'spatial', 'atlas_explorer']
LOCALES = ['en', 'ko', 'ja', 'zh-Hant-TW', 'zh-Hans-CN', 'templates', 'supplemental']
GUIDES = {'NISSL_WORKFLOW_GUIDE.md': 'analysis-pipeline-guide.md',
          'STUDY_WORKFLOW_GUIDE.md': 'study-pipeline-guide.md',
          'BROWSER_MODEL.md': 'browser-model-guide.md',
          'TIFF_COMPATIBILITY.md': 'tiff-compatibility-guide.md'}
BUNDLES = {
    'cerebellum-synthetic-example.zip': ['examples/synthetic-section/synthetic-section.tif', 'examples/synthetic-section/synthetic-section_ROIs.zip',
        'examples/synthetic-section/README.txt'],
    'cerebellum-auto-roi.zip': ['scripts/train_native_cohort.py', 'scripts/auto_roi_paths.py',
        'scripts/native_tiff.py', 'scripts/roi_training_masks.py', 'scripts/nissl_lab.py',
        'scripts/prepare_training_sources.py', 'scripts/Start-Auto-ROI.command',
        'scripts/requirements-auto-roi.txt', 'docs/AUTO_ROI_MAC_KO.txt'],
    'cerebellum-training-preparation.zip': ['scripts/prepare_training_sources.py',
        'scripts/native_tiff.py', 'scripts/roi_training_masks.py', 'scripts/nissl_lab.py',
        'scripts/Start-Training-Preparation.command', 'docs/TRAINING_PREPARATION_MAC_KO.txt'],
    'nissl-local-runner.zip': ['scripts/nissl_predict.py', 'scripts/requirements-nissl.txt',
        'examples/nissl-model-manifest.json', 'docs/NISSL_MODEL_RUNNER.md'],
    'nissl-lab-tools.zip': ['scripts/nissl_lab.py', 'scripts/nissl_predict.py',
        'scripts/imagej_measurements.java', 'scripts/requirements-lab.txt',
        'scripts/requirements-nissl.txt', 'scripts/prepare_atlas.py',
        'scripts/requirements-atlas.txt', 'examples/nissl-lab-manifest.json',
        'examples/nissl-model-manifest.json', 'docs/LOCAL_LAB.md',
        'docs/NISSL_MODEL_RUNNER.md', 'docs/ATLAS_IMPORT.md',
        'docs/STUDY_WORKFLOW_GUIDE.md', 'docs/STUDY_DATA_CONTRACT.md',
        'docs/INDEPENDENT_VALIDATION.md', 'docs/PHYSICAL_RECONSTRUCTION.md'],
    'cerebellum-tiff-tools.zip': ['scripts/prepare_tiff_compatibility.py',
        'scripts/requirements-tiff-compatibility.txt', 'scripts/Start-TIFF-Compatibility.command',
        'docs/TIFF_COMPATIBILITY.md'],
    'cerebellum-research-intake.zip': ['scripts/prepare_research_intake.py',
        'scripts/research_intake_checks.py', 'scripts/nissl_lab.py',
        'scripts/Start-Research-Intake.command', 'docs/RESEARCH_INTAKE_MAC_KO.txt'],
    'cerebellum-atlas-tools.zip': ['scripts/prepare_atlas_pdf.py',
        'scripts/requirements-atlas-pdf.txt', 'scripts/Start-Atlas-Index.command',
        'docs/ATLAS_PDF_PREPARATION.md', 'docs/ATLAS_MAC_QUICKSTART_KO.txt'],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


PRIVATE_BLOCK = re.compile(r'[ \t]*<!--private:start-->.*?<!--private:end-->[ \t]*\n?', re.S)
PRIVATE_MARK = re.compile(r'[ \t]*<!--private:(?:start|end)-->[ \t]*\n?')
# Download packages that carry one laboratory's animal list. A public-safe build leaves them out,
# together with the panels that offer them, until they are generalised.
LAB_PACKAGES = ['downloads/cerebellum-auto-roi.zip', 'downloads/cerebellum-research-intake.zip',
                'downloads/cerebellum-training-preparation.zip']


def exclusion_pattern():
    """Names a public-safe build must not carry, or None where no list is kept."""
    source = R / 'config/private/public-exclusion-terms.json'
    if not source.is_file():
        return None
    terms = json.loads(source.read_text(encoding='utf-8'))['terms']
    if not terms or any(not isinstance(term, str) or not term for term in terms):
        raise ValueError('The exclusion term list is empty or malformed.')
    # Any letter case: a name written in lower case is still the name.
    return re.compile('(?<![A-Za-z0-9])(?:' + '|'.join(re.escape(term) for term in terms) + ')(?![A-Za-z0-9])', re.IGNORECASE)


class _Texts(html_parser.HTMLParser):
    """The text and labelled attributes of a piece of page markup, as the catalogs key them."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found = set()

    def keep(self, text):
        text = re.sub(r'\s+', ' ', text or '').strip()
        if text:
            self.found.add(text)

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ('title', 'aria-label', 'placeholder', 'alt'):
                self.keep(value)

    def handle_data(self, data):
        self.keep(data)


def page_texts(markup):
    parser = _Texts()
    parser.feed(markup)
    return parser.found


def private_only_texts(page_with_markers):
    """Texts that appear in a private block and nowhere else: not in the public page, not in any script."""
    private = set().union(*[page_texts(block) for block in PRIVATE_BLOCK.findall(page_with_markers)] or [set()])
    public = page_texts(PRIVATE_BLOCK.sub('', page_with_markers))
    scripts = '\n'.join(source.read_text(encoding='utf-8') for source in sorted((R / 'src').glob('*.js')))
    return {text for text in private - public if text not in scripts}


def public_catalogs(pattern, private_only):
    """Interface catalogs without the entries that only private blocks use, and without any entry that names an animal."""
    data = {name: json.loads((R / f'src/locales/{name}.json').read_text(encoding='utf-8')) for name in LOCALES}
    languages = [name for name in LOCALES if name not in ('supplemental', 'templates')]
    named = lambda value: isinstance(value, str) and pattern is not None and bool(pattern.search(value))
    drop = {key for name in languages for key, value in data[name].items() if named(key) or named(value) or key.strip() in private_only}
    for name in languages:
        data[name] = {key: value for key, value in data[name].items() if key not in drop}
    drop = {key for block in data['supplemental'].values() for key, value in block.items() if named(key) or named(value) or key.strip() in private_only}
    data['supplemental'] = {language: {key: value for key, value in block.items() if key not in drop}
                            for language, block in data['supplemental'].items()}
    data['templates'] = [row for row in data['templates'] if not named(json.dumps(row, ensure_ascii=False))]
    return data


def named_files(stage, pattern):
    """Every staged file, and every member of a staged archive, that carries an excluded name."""
    found = {}
    binary = re.compile(pattern.pattern.encode('utf-8'), re.IGNORECASE)
    for path in sorted(p for p in stage.rglob('*') if p.is_file()):
        relative = str(path.relative_to(stage))
        blob = path.read_bytes()
        if path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                count = sum(len(binary.findall(archive.read(member))) + len(pattern.findall(member))
                            for member in archive.namelist())
        else:
            count = len(binary.findall(blob))
        count += len(pattern.findall(relative))
        if count:
            found[relative] = count
    return found


def build(profile='private', output=None, allow_unchecked_names=False):
    public_inputs = all('public-safe' in entry['profiles'] for entry in json.loads((R / 'config/build-inputs.json').read_text())['files'])
    output = R / (output or ('dist' if profile == 'private' or public_inputs else 'dist-public-safe'))
    # Only dedicated build directories may be replaced. Never remove a source tree,
    # symlink, nested source directory or arbitrary user-selected destination.
    if output.parent.resolve() != R or not (output.name == 'dist' or output.name.startswith('dist-')):
        raise ValueError('Output must be dist or a dist-* directory directly inside the repository.')
    if output.is_symlink() or (output.exists() and not output.is_dir()):
        raise ValueError('Output must be a real build directory, not a link or file.')
    registry = json.loads((R / 'config/build-inputs.json').read_text())
    # A tree whose input list holds nothing private is the public edition: it builds the public-safe site, into dist.
    public_tree = all('public-safe' in entry['profiles'] for entry in registry['files'])
    if public_tree:
        profile = 'public-safe'
    if profile == 'public-safe' and output.name == 'dist' and not public_tree:
        raise ValueError('Use a separate dist-* output for the public-safe profile.')
    for entry in registry['files']:
        if profile not in entry['profiles']:
            continue                      # a tree without private data can still make the public-safe build
        source = R / entry['source']
        if not source.is_file() or source.is_symlink() or digest(source) != entry['sha256']:
            raise ValueError(f"Missing or changed immutable input: {entry['source']}")
    stage = Path(tempfile.mkdtemp(prefix='.site-build-', dir=R))
    expected = set()
    origins = {}

    def record(target, sources):
        relative = str(target.relative_to(stage))
        if relative in expected:
            raise ValueError(f'Duplicate build output: {relative}')
        expected.add(relative)
        origins[relative] = sorted(set(sources))

    def copy(source, relative):
        source = Path(source)
        if source.is_symlink() or not source.is_file():
            raise ValueError(f'Input must be a regular file: {source}')
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        record(target, [str(source.relative_to(R))])

    try:
        a = stage / 'assets'
        a.mkdir()
        html = (R / 'src/index.template.html').read_text(encoding='utf-8')
        html_sources = ['src/index.template.html']
        for panel in PANELS:
            source = f'src/{panel}_panel.html'
            html = html.replace('__' + panel.upper() + '_PANEL__', (R / source).read_text(encoding='utf-8'))
            html_sources.append(source)
        if re.search(r'__[A-Z_]+_PANEL__', html):
            raise ValueError('Unresolved HTML panel marker.')
        if html.count('<!--private:start-->') != html.count('<!--private:end-->'):
            raise ValueError('Unbalanced private block markers.')
        # Passages about one laboratory's own animals are left out of a public-safe build.
        private_only = private_only_texts(html)
        html = (PRIVATE_BLOCK if profile == 'public-safe' else PRIVATE_MARK).sub('', html)
        if '<!--private:' in html:
            raise ValueError('A private block marker was left in the page.')
        models = [entry for entry in registry['files'] if entry.get('role') == 'trained-model' and profile in entry['profiles']]
        atlases = [entry for entry in registry['files'] if entry.get('role') == 'open-atlas' and profile in entry['profiles']]
        if len(models) > 1 or len(atlases) > 1:
            raise ValueError('At most one built-in model and one atlas reference are published.')
        deployment = {'schema': 'cerebellum-deployment-profile/1', 'profile': profile,
                      'built_in_model': ({'url': './' + models[0]['output'], 'sha256': models[0]['sha256'], 'bytes': models[0]['bytes'],
                                          'id': models[0]['model_id']} if models else None),
                      'example_data_available': profile == 'private',
                      'atlas_reference_available': bool(atlases),
                      'atlas_reference': ({'url': './' + atlases[0]['output'], 'sha256': atlases[0]['sha256']} if atlases else None),
                      'collaboration_server_available': False,
                      'public_release_authorized': False}
        if '</head>' not in html:
            raise ValueError('HTML template has no head closing tag.')
        html = html.replace('</head>', '<script id="deployment-profile" type="application/json">' +
                            json.dumps(deployment, sort_keys=True) + '</script>\n</head>', 1)
        (stage / 'index.html').write_text(html, encoding='utf-8')
        record(stage / 'index.html', html_sources + ['build_site.py'])
        for source in sorted((R / 'src').glob('*.js')):
            if source.name not in ['viewer.js', 'annotation_adapter.js']:
                copy(source, 'assets/' + source.name)
        viewer_sources = ['src/viewer.js', 'src/annotation_adapter.js', 'src/explorer.js']
        viewer = (R / viewer_sources[0]).read_text(encoding='utf-8')
        viewer = viewer.replace('__ANNOTATION_ADAPTER__', (R / viewer_sources[1]).read_text(encoding='utf-8'))
        viewer = viewer.replace('__STUDIO_EXPLORER__', (R / viewer_sources[2]).read_text(encoding='utf-8'))
        (a / 'viewer.js').write_text(viewer, encoding='utf-8')
        record(a / 'viewer.js', viewer_sources)
        for source in sorted((R / 'src').glob('*.css')):
            copy(source, 'assets/' + source.name)
        excluded = exclusion_pattern() if profile == 'public-safe' else None
        if profile == 'public-safe':
            # Without the list of names the check cannot run; that is refused unless it is asked for in so many words.
            if excluded is None and not allow_unchecked_names and not public_tree:
                raise ValueError('No exclusion term list (config/private/public-exclusion-terms.json): a public-safe build is not made '
                                 'without its name check. Pass --allow-unchecked-names to build anyway.')
            for name, catalog in public_catalogs(excluded, private_only).items():
                target = a / 'locales' / f'{name}.json'
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                record(target, [f'src/locales/{name}.json', 'build_site.py'])
        else:
            for name in LOCALES:
                copy(R / f'src/locales/{name}.json', f'assets/locales/{name}.json')
        # The drawings under src/atlas come from a printed atlas and are no longer built into any edition;
        # the atlas view reads the open-licence plane series registered as a build input.
        for entry in registry['files']:
            if profile in entry['profiles']:
                copy(R / entry['source'], entry['output'])
        for source in sorted((R / 'vendor').rglob('*')):
            if source.is_file():
                copy(source, 'vendor/' + str(source.relative_to(R / 'vendor')))
        for name, target in GUIDES.items():
            copy(R / 'docs' / name, 'downloads/' + target)
        if profile == 'private':
            copy(R / 'docs/audits/2026-11-04/REMEDIATION_REPORT.pdf', 'downloads/cerebellum-remediation-report.pdf')
            copy(R / 'docs/audits/2026-11-04/remediation-ledger.json', 'downloads/cerebellum-remediation-ledger.json')
            review = R / 'docs/audits/2026-11-04-v23-review'
            copy(review / 'Cerebellum-Studio-v23-Review-and-Automation.pdf', 'downloads/cerebellum-v23-completion-review.pdf')
            copy(review / 'completion-matrix.csv', 'downloads/cerebellum-v23-completion-matrix.csv')
            copy(R / 'docs/MIXED_ROI_CORRECTIONS.md', 'downloads/mixed-roi-corrections.md')
        for bundle_name, names in BUNDLES.items():
            # Tools written for one laboratory's folders and animal list stay out of a public-safe build, with their panels.
            if profile == 'public-safe' and (bundle_name == 'cerebellum-atlas-tools.zip' or 'downloads/' + bundle_name in LAB_PACKAGES):
                continue
            names = list(names)
            if profile == 'private' and bundle_name == 'cerebellum-research-intake.zip':
                names += ['config/research-cohort-declaration.json']
            if profile == 'private' and bundle_name in ['cerebellum-training-preparation.zip', 'cerebellum-auto-roi.zip']:
                names += ['config/private/cohort-pairing-plan.json']
            if bundle_name not in ['cerebellum-synthetic-example.zip', 'cerebellum-atlas-tools.zip', 'cerebellum-research-intake.zip', 'cerebellum-tiff-tools.zip', 'cerebellum-training-preparation.zip', 'cerebellum-auto-roi.zip']:
                names += [str(p.relative_to(R)) for p in sorted((R / 'scripts/locks').glob('*')) if p.is_file()]
                names += ['scripts/environment_manifest.py', 'docs/REPRODUCIBLE_RELEASE.md']
            target = stage / 'downloads' / bundle_name
            with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
                for name in sorted(names):
                    archive_name = (bundle_name.removesuffix('.zip') + '/' + Path(name).name
                                    if bundle_name in ['cerebellum-synthetic-example.zip', 'cerebellum-atlas-tools.zip', 'cerebellum-research-intake.zip', 'cerebellum-tiff-tools.zip', 'cerebellum-training-preparation.zip', 'cerebellum-auto-roi.zip'] else name)
                    info = zipfile.ZipInfo(archive_name, date_time=(2026, 11, 3, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.create_system = 3
                    info.external_attr = (0o100755 if name.endswith('.command') else 0o100644) << 16
                    bundle.writestr(info, (R / name).read_bytes())
            record(target, names + ['build_site.py'])
        actual = {str(p.relative_to(stage)) for p in stage.rglob('*') if p.is_file()}
        if actual != expected:
            raise ValueError('Output allowlist mismatch.')
        name_check = {'status': 'not applicable to the private profile'}
        if profile == 'public-safe':
            if excluded is None:
                name_check = {'status': 'not run here: the public tree was checked for names when it was exported' if public_tree else
                              'not run: no exclusion term list in this checkout; built because --allow-unchecked-names was given'}
            else:
                named = named_files(stage, excluded)
                # The built-in model names its training and evaluation animals in its provenance, by the researcher's decision.
                by_decision = [entry['output'] for entry in models]
                refused = {name: count for name, count in named.items() if name not in LAB_PACKAGES + by_decision}
                if refused:
                    raise ValueError('Excluded names remain in the public-safe build: ' +
                                     ', '.join(f'{name} ({count})' for name, count in sorted(refused.items())))
                name_check = {'status': 'passed for the site and every download except the files listed here',
                              'laboratory_packages_still_naming_animals': sorted(name for name in named if name in LAB_PACKAGES),
                              'files_naming_animals_by_decision': sorted(name for name in named if name in by_decision)}
        manifest = {'schema': 'cerebellum-build-manifest/1', 'profile': profile,
                    'public_release_authorized': False, 'excluded_name_check': name_check,
                    'rights_scope': 'Technical asset exclusion does not grant code, data or atlas redistribution rights.',
                    'files': [{'path': name, 'sha256': digest(stage / name),
                               'bytes': (stage / name).stat().st_size, 'sources': origins[name]}
                              for name in sorted(expected)]}
        write_json(stage / 'build-manifest.json', manifest)
        backup = None
        if output.exists():
            backup = Path(tempfile.mkdtemp(prefix='.site-previous-', dir=R))
            backup.rmdir()
            output.rename(backup)
        try:
            stage.rename(output)
        except BaseException:
            if backup:
                backup.rename(output)
            raise
        if backup:
            shutil.rmtree(backup)
        print(f'Cerebellum Studio ready: {output.name} ({profile}), {len(expected) + 1} files')
        return manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['private', 'public-safe'], default='private')
    parser.add_argument('--output', help='dist or dist-* directory within this repository')
    parser.add_argument('--allow-unchecked-names', action='store_true',
                        help='Make a public-safe build even where no exclusion term list exists; the manifest records that the check did not run.')
    args = parser.parse_args()
    build(args.profile, args.output, args.allow_unchecked_names)


if __name__ == '__main__':
    main()
