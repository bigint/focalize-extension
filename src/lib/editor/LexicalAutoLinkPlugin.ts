/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { LinkAttributes } from '@lexical/link';
import type { ElementNode, LexicalEditor, LexicalNode } from 'lexical';

import {
    $createAutoLinkNode,
    $isAutoLinkNode,
    $isLinkNode,
    AutoLinkNode,
} from '@lexical/link';
import { mergeRegister } from '@lexical/utils';
import {
    $createTextNode,
    $isElementNode,
    $isLineBreakNode,
    $isTextNode,
    TextNode,
} from 'lexical';

type ChangeHandler = (url: string | null, prevUrl: string | null) => void;

type LinkMatcherResult = {
    attributes?: LinkAttributes;
    index: number;
    length: number;
    text: string;
    url: string;
};

const URL_REGEX =
    /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

const EMAIL_REGEX =
    /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

const MATCHERS = [
    createLinkMatcherWithRegExp(URL_REGEX, (text) => {
        return text.startsWith('http') ? text : `https://${text}`;
    }),
    createLinkMatcherWithRegExp(EMAIL_REGEX, (text) => {
        return `mailto:${text}`;
    }),
];

export type LinkMatcher = (text: string) => LinkMatcherResult | null;

export function createLinkMatcherWithRegExp(
    regExp: RegExp,
    urlTransformer: (text: string) => string = (text) => text
) {
    return (text: string) => {
        const match = regExp.exec(text);
        if (match === null) return null;
        return {
            index: match.index,
            length: match[0].length,
            text: match[0],
            url: urlTransformer(text),
        };
    };
}

const findFirstMatch = (
    text: string,
    matchers: Array<LinkMatcher>
): LinkMatcherResult | null => {
    for (const item of matchers) {
        const match = item(text);

        if (match) {
            return match;
        }
    }

    return null;
};

const PUNCTUATION_OR_SPACE = /[.,;\s]/;

const isSeparator = (char: string): boolean => PUNCTUATION_OR_SPACE.test(char);

const endsWithSeparator = (textContent: string): boolean =>
    isSeparator(textContent[textContent.length - 1]);

const startsWithSeparator = (textContent: string): boolean =>
    isSeparator(textContent[0]);

const isPreviousNodeValid = (node: LexicalNode): boolean => {
    let previousNode = node.getPreviousSibling();
    if ($isElementNode(previousNode)) {
        previousNode = previousNode.getLastDescendant();
    }
    return (
        previousNode === null ||
        $isLineBreakNode(previousNode) ||
        ($isTextNode(previousNode) &&
            endsWithSeparator(previousNode.getTextContent()))
    );
};

const isNextNodeValid = (node: LexicalNode): boolean => {
    let nextNode = node.getNextSibling();
    if ($isElementNode(nextNode)) {
        nextNode = nextNode.getFirstDescendant();
    }
    return (
        nextNode === null ||
        $isLineBreakNode(nextNode) ||
        ($isTextNode(nextNode) &&
            startsWithSeparator(nextNode.getTextContent()))
    );
};

const isContentAroundIsValid = (
    matchStart: number,
    matchEnd: number,
    text: string,
    node: TextNode
): boolean => {
    const contentBeforeIsValid =
        matchStart > 0
            ? isSeparator(text[matchStart - 1])
            : isPreviousNodeValid(node);
    if (!contentBeforeIsValid) {
        return false;
    }

    const contentAfterIsValid =
        matchEnd < text.length
            ? isSeparator(text[matchEnd])
            : isNextNodeValid(node);
    return contentAfterIsValid;
};

const handleLinkCreation = (
    node: TextNode,
    matchers: Array<LinkMatcher>,
    onChange: ChangeHandler
): void => {
    const nodeText = node.getTextContent();
    let text = nodeText;
    let invalidMatchEnd = 0;
    let remainingTextNode = node;
    let match;

    // tslint:disable-next-line:no-conditional-assignment
    while ((match = findFirstMatch(text, matchers))) {
        const matchStart = match.index;
        const matchLength = match.length;
        const matchEnd = matchStart + matchLength;
        const isValid = isContentAroundIsValid(
            invalidMatchEnd + matchStart,
            invalidMatchEnd + matchEnd,
            nodeText,
            node
        );

        if (isValid) {
            let linkTextNode;
            if (invalidMatchEnd + matchStart === 0) {
                [linkTextNode, remainingTextNode] = remainingTextNode.splitText(
                    invalidMatchEnd + matchLength
                );
            } else {
                [, linkTextNode, remainingTextNode] =
                    remainingTextNode.splitText(
                        invalidMatchEnd + matchStart,
                        invalidMatchEnd + matchStart + matchLength
                    );
            }
            const linkNode = $createAutoLinkNode(match.url, match.attributes);
            const textNode = $createTextNode(match.text);
            textNode.setFormat(linkTextNode.getFormat());
            textNode.setDetail(linkTextNode.getDetail());
            linkNode.append(textNode);
            linkTextNode.replace(linkNode);
            onChange(match.url, null);
            invalidMatchEnd = 0;
        } else {
            invalidMatchEnd += matchEnd;
        }

        text = text.substring(matchEnd);
    }
};

const replaceWithChildren = (node: ElementNode): Array<LexicalNode> => {
    const children = node.getChildren();
    const childrenLength = children.length;

    for (let j = childrenLength - 1; j >= 0; j--) {
        node.insertAfter(children[j]);
    }

    node.remove();
    return children.map((child) => child.getLatest());
};

const handleLinkEdit = (
    linkNode: AutoLinkNode,
    matchers: Array<LinkMatcher>,
    onChange: ChangeHandler
): void => {
    // Check children are simple text
    const children = linkNode.getChildren();
    const childrenLength = children.length;
    for (let i = 0; i < childrenLength; i++) {
        const child = children[i];
        if (!$isTextNode(child) || !child.isSimpleText()) {
            replaceWithChildren(linkNode);
            onChange(null, linkNode.getURL());
            return;
        }
    }

    // Check text content fully matches
    const text = linkNode.getTextContent();
    const match = findFirstMatch(text, matchers);
    if (match === null || match.text !== text) {
        replaceWithChildren(linkNode);
        onChange(null, linkNode.getURL());
        return;
    }

    // Check neighbors
    if (!isPreviousNodeValid(linkNode) || !isNextNodeValid(linkNode)) {
        replaceWithChildren(linkNode);
        onChange(null, linkNode.getURL());
        return;
    }

    const url = linkNode.getURL();
    if (url !== match.url) {
        linkNode.setURL(match.url);
        onChange(match.url, url);
    }

    if (match.attributes) {
        const rel = linkNode.getRel();
        if (rel !== match.attributes.rel) {
            linkNode.setRel(match.attributes.rel || null);
            onChange(match.attributes.rel || null, rel);
        }

        const target = linkNode.getTarget();
        if (target !== match.attributes.target) {
            linkNode.setTarget(match.attributes.target || null);
            onChange(match.attributes.target || null, target);
        }
    }
};
// Bad neighbours are edits in neighbor nodes that make AutoLinks incompatible.
// Given the creation preconditions, these can only be simple text nodes.

const handleBadNeighbors = (
    textNode: TextNode,
    matchers: Array<LinkMatcher>,
    onChange: ChangeHandler
): void => {
    const previousSibling = textNode.getPreviousSibling();
    const nextSibling = textNode.getNextSibling();
    const text = textNode.getTextContent();

    if ($isAutoLinkNode(previousSibling) && !startsWithSeparator(text)) {
        previousSibling.append(textNode);
        handleLinkEdit(previousSibling, matchers, onChange);
        onChange(null, previousSibling.getURL());
    }

    if ($isAutoLinkNode(nextSibling) && !endsWithSeparator(text)) {
        replaceWithChildren(nextSibling);
        handleLinkEdit(nextSibling, matchers, onChange);
        onChange(null, nextSibling.getURL());
    }
};

export const registerAutoLink = (
    editor: LexicalEditor,
    matchers: Array<LinkMatcher> = MATCHERS,
    onChange?: ChangeHandler
) => {
    if (!editor.hasNodes([AutoLinkNode])) {
        throw new Error('AutoLinkNode not registered on editor');
    }

    const onChangeWrapped = (url: string | null, prevUrl: string | null) => {
        if (onChange) {
            onChange(url, prevUrl);
        }
    };

    return mergeRegister(
        editor.registerNodeTransform(TextNode, (textNode: TextNode) => {
            const parent = textNode.getParentOrThrow();
            const previous = textNode.getPreviousSibling();
            if ($isAutoLinkNode(parent)) {
                handleLinkEdit(parent, matchers, onChangeWrapped);
            } else if (!$isLinkNode(parent)) {
                if (
                    textNode.isSimpleText() &&
                    (startsWithSeparator(textNode.getTextContent()) ||
                        !$isAutoLinkNode(previous))
                ) {
                    handleLinkCreation(textNode, matchers, onChangeWrapped);
                }

                handleBadNeighbors(textNode, matchers, onChangeWrapped);
            }
        })
    );
};
