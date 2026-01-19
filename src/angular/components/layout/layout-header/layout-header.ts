/**
 * @fileoverview Header component for the application title bar area.
 *
 * This component renders the top header area of the media player window.
 * It provides a draggable area for window movement on macOS.
 *
 * @module app/components/layout/layout-header
 */

import {Component} from '@angular/core';

/**
 * Header component displaying the application title bar area.
 *
 * The header is styled to blend with the Electron window chrome and
 * provides drag-to-move functionality on macOS via CSS (-webkit-app-region: drag).
 *
 * @example
 * <!-- In a parent template -->
 * <app-layout-header />
 */
@Component({
  selector: 'app-layout-header',
  imports: [],
  templateUrl: './layout-header.html',
  styleUrl: './layout-header.scss',
})
export class LayoutHeader {}
