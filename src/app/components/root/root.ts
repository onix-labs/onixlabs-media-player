import { Component } from '@angular/core';
import {LayoutHeader} from '../layout/layout-header/layout-header';
import {LayoutOutlet} from '../layout/layout-outlet/layout-outlet';
import {LayoutControls} from '../layout/layout-controls/layout-controls';

@Component({
  selector: 'app-root',
  imports: [LayoutHeader, LayoutOutlet, LayoutControls],
  templateUrl: './root.html',
  styleUrl: './root.scss',
})
export class Root {

}
