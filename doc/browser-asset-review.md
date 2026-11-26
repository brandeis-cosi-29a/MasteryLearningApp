# Browser asset cleanup: required review before merge

This cleanup must pass a visual and interaction review before it is merged.
Compare the PR branch with its Express 5 parent using synthetic course data.
Review at a desktop width (1280 px) and a narrow phone width (375 px).

Application and landing pages now share Bootstrap 5.3.0 CSS and its JavaScript
bundle, including Popper, plus Bootstrap Icons 1.10.5. These are the versions
already used by the landing page. Shared EJS partials hold the versioned CDN
URLs and integrity hashes. Application pages retain the locally served
Font Awesome Free CSS and fonts; the two external account-owned kits, jQuery,
and standalone Popper are removed. MathJax is unchanged.

| Page or workflow | Required check |
| --- | --- |
| Landing page and login/error pages | Spacing, typography, colors, icons, and responsive navigation remain usable. |
| Staff course dashboard and roster | Tables, forms, action buttons, and edit/add/download/delete icons remain legible and aligned. |
| Add MLA problem | All three tabs switch and expose their corresponding inputs. |
| Skill summary | Tooltips appear with the correct skill names and placement. |
| Student MLA and PRA problem pages | Answer fields, photo controls, feedback, and MathJax remain readable on desktop and phone. |
| Review and grading pages | Empty/selected thumbs render, votes update counts and toggle icons, and grading controls remain usable. |
| Refreshing header | Render the retained `bootheaderReloading.ejs` partial with a synthetic title; confirm styles and local icons load. No current view includes it. |
| Browser network and console | No missing styles/fonts, integrity failures, JavaScript errors, kit requests, jQuery requests, or separate Popper requests. |

Also verify Google login/logout and an existing signed session on the eventual
test deployment. Application fetch requests use same-origin paths; global
allow-all CORS is removed. Top-level OAuth redirects do not depend on CORS.
This does not change server-side authorization or add CSRF protection.

Record the compared commits, browsers, viewport widths, results, and any accepted
visual differences in the PR review. Resolve regressions before merge. Automated
HTTP and template checks do not complete this visual review.
