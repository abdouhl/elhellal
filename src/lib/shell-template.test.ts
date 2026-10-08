import { describe, it, expect } from 'vitest';
import { fillTemplate, shellMarkers } from './shell-template';

describe('fillTemplate', () => {
    it('escapes {{tokens}} and leaves {{{raw}}} alone', () => {
        expect(fillTemplate('<p title="{{t}}">{{t}}</p>{{{r}}}', { t: '"a" & <b>', r: '<i>x</i>' }))
            .toBe('<p title="&quot;a&quot; &amp; &lt;b&gt;">&quot;a&quot; &amp; &lt;b&gt;</p><i>x</i>');
    });

    it('JSON-escapes {{jt:tokens}} before HTML-escaping', () => {
        expect(fillTemplate('{{jt:t}}', { t: 'say "hi"\\' })).toBe('say \\&quot;hi\\&quot;\\\\');
    });

    it('renders missing values as empty', () => {
        expect(fillTemplate('[{{nope}}]', {})).toBe('[]');
    });

    it('keeps or drops #if blocks, including negated and nested ones', () => {
        const tpl = '<!--#if a-->A<!--#if !b-->notB<!--/if !b--><!--/if a--><!--#if b-->B<!--/if b-->';
        expect(fillTemplate(tpl, { a: 1, b: '' })).toBe('AnotB');
        expect(fillTemplate(tpl, { a: 0, b: 'x' })).toBe('B');
        expect(fillTemplate('<!--#if l-->L<!--/if l-->', { l: [] })).toBe('');
    });

    it('repeats #each blocks with item-scoped tokens and ifs', () => {
        const tpl = '<!--#each xs--><!--#if .href--><a href="{{.href}}">{{.label}}</a><!--/if .href--><!--#if !.href--><span>{{.label}}</span><!--/if !.href--><!--/each xs-->';
        expect(fillTemplate(tpl, { xs: [{ label: 'a', href: '/a' }, { label: 'b<', href: '' }] }))
            .toBe('<a href="/a">a</a><span>b&lt;</span>');
    });

    it('never re-reads substituted data as template syntax', () => {
        expect(fillTemplate('{{a}}|{{b}}', { a: '{{b}}', b: 'B' })).toBe('{{b}}|B');
        const out = fillTemplate('<!--#each xs-->{{.t}}<!--/each xs-->', { xs: [{ t: '{{secret}}' }], secret: 'S' });
        expect(out).not.toContain('S');
        expect(out).toBe('&#123;&#123;secret&#125;&#125;');
    });
});

describe('shellMarkers', () => {
    it('emits markers only for shells', () => {
        expect(shellMarkers(true).open('x')).toBe('<!--#if x-->');
        expect(shellMarkers(false).open('x')).toBe('');
    });
});
